/**
 * Sage mode self-test: exercises the plugin against a mock Cordis context.
 *
 * It covers what can be verified without a running profile — config
 * validation, the session-log fold, the command contract, per-agent
 * restriction/guard ownership, and teardown. Live activation in a profile is
 * verified separately through the Host Inspect providers.
 *
 * Run with: node test/self-test.mjs
 */
import assert from 'node:assert/strict'
import { apply, name } from '../index.js'

const FULL_TOOLS = [
  'ops_glob', 'ops_grep', 'ops_inspect_local_file', 'ops_replace',
  'load_workspace_dependencies', 'read', 'read_image', 'write', 'edit',
  'glob', 'grep', 'skill', 'ask_user_question', 'web_search', 'web_fetch', 'present',
  'cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager', 'pwsh',
  'todo_write',
]

/** Minimal Cordis host: enough of `ctx` for this plugin, plus recording hooks. */
function createHarness(options = {}) {
  const toolNames = options.toolNames ?? FULL_TOOLS
  const listeners = new Map()
  const disposers = []
  const record = { sections: [], commands: [], restrictions: [], guards: [], steered: [] }

  const toolsService = {
    schemas: () => toolNames.map((tool) => ({ name: tool })),
    restrict: (filter) => {
      const entry = { filter, lifted: false }
      record.restrictions.push(entry)
      return () => {
        entry.lifted = true
      }
    },
    guard: (fn) => {
      const entry = { fn, lifted: false }
      record.guards.push(entry)
      return () => {
        entry.lifted = true
      }
    },
  }

  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    get(key) {
      if (key === 'tools') return toolsService
      if (key === 'agents') return { list: () => options.liveAgents ?? [] }
      return undefined
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    inject(services, callback) {
      if (!services.includes('commands')) return
      callback({
        commands: {
          register: (definition) => {
            record.commands.push(definition)
            return () => {
              definition.disposed = true
            }
          },
        },
        effect: ctx.effect,
      })
    },
  }

  const makeAgent = (events = [], id = `session-${record.sections.length + 1}`) => {
    const agent = {
      id,
      session: { snapshotEvents: () => events },
      ctx: {
        systemPrompt: {
          section: (section) => {
            record.sections.push(section)
            return () => {
              section.disposed = true
            }
          },
        },
        tools: toolsService,
      },
      steer: (message) => {
        record.steered.push(message)
      },
    }
    return agent
  }

  return {
    ctx,
    record,
    makeAgent,
    toolsService,
    emit: (event, payload) => {
      for (const fn of listeners.get(event) ?? []) fn(payload)
    },
    unload: () => {
      for (const disposer of disposers) disposer()
    },
  }
}

const run = (harness, agent, rawInput, attachments = []) => {
  const command = harness.record.commands.at(-1)
  assert.ok(command, 'the mode command must be registered')
  return command.handler({ agent, rawInput, attachments })
}

const sectionText = (harness) => {
  const section = harness.record.sections.at(-1)
  assert.ok(section, 'a prompt section must be registered for the agent')
  return section.text()
}

const restriction = (harness) => harness.record.restrictions.at(-1)
const guard = (harness) => harness.record.guards.at(-1)

const runHistory = (commandName, wanted, kind = 'success', args) => ([
  { type: 'command/run', data: { name: commandName, args: wanted === false ? 'off' : args, commandId: 'c1' } },
  { type: 'command/done', data: { commandId: 'c1', kind } },
])

const tests = []
const test = (label, fn) => tests.push({ label, fn })

test('exports its plugin name', () => {
  assert.equal(name, 'dsh-sage-mode')
})

test('rejects unknown config keys', () => {
  const { ctx } = createHarness()
  assert.throws(() => apply(ctx, { nope: true }), /unknown config key/)
})

test('tolerates a missing row config', () => {
  const { ctx, record } = createHarness()
  apply(ctx, undefined)
  assert.equal(record.commands.length, 1)
  assert.equal(record.commands[0].name, 'sage')
})

test('/sage enters the mode: read-only tools stay, the rest are hidden', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const agent = harness.makeAgent()
  const result = run(harness, agent, '')

  assert.equal(result.kind, 'success')
  const entry = restriction(harness)
  assert.deepEqual(entry.filter, { allow: [
    'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch',
    'ask_user_question', 'skill', 'ops_glob', 'ops_grep',
    'ops_inspect_local_file', 'cordis_inspect_list', 'cordis_inspect_query',
    'load_workspace_dependencies',
  ] })
  assert.match(sectionText(harness), /Sage mode/)
  assert.equal(harness.record.steered.length, 0)
})

test('the guard admits the allowed tools and denies mutation', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const agent = harness.makeAgent()
  run(harness, agent, '')

  const check = guard(harness).fn
  assert.equal(check({ name: 'read' }), undefined)
  assert.equal(check({ name: 'grep' }), undefined)
  assert.match(check({ name: 'write' }), /Sage mode/)
  assert.match(check({ name: 'pwsh' }), /Sage mode/)
  // PTC mode presents every capability through this transport.
  assert.equal(check({ name: 'run_code' }), undefined)
})

test('/sage off restores the tools and silences the section', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const agent = harness.makeAgent()
  run(harness, agent, '')
  const result = run(harness, agent, 'off')

  assert.equal(result.kind, 'success')
  assert.equal(restriction(harness).lifted, true)
  assert.equal(guard(harness).lifted, true)
  assert.equal(sectionText(harness), '')
})

test('/sage off rejects attachments before changing state', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const agent = harness.makeAgent()
  run(harness, agent, '')
  const result = run(harness, agent, 'off', [{ type: 'image', attachment: {} }])

  assert.equal(result.kind, 'error')
  assert.equal(sectionText(harness).length > 0, true, 'the mode must stay on')
  assert.equal(restriction(harness).lifted, false)
})

test('/sage <message> enters the mode and hands the text over', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const agent = harness.makeAgent()
  const result = run(harness, agent, '  解释一下这个报错  ')

  assert.equal(result.kind, 'success')
  assert.deepEqual(harness.record.steered.at(-1).content, [{ type: 'text', text: '解释一下这个报错' }])
  assert.equal(harness.record.steered.at(-1).role, 'user')
  assert.equal(sectionText(harness).length > 0, true)
})

test('a resumed session recovers the mode from the log', () => {
  const events = runHistory('sage', true)
  const harness = createHarness()
  apply(harness.ctx)
  const agent = harness.makeAgent(events)
  harness.emit('agent/created', { agent })

  assert.equal(restriction(harness).filter.allow.includes('read'), true)
  assert.match(sectionText(harness), /Sage mode/)
})

test('a failed or foreign command run does not enable the mode', () => {
  const failed = createHarness()
  apply(failed.ctx)
  const failedAgent = failed.makeAgent(runHistory('sage', true, 'error'))
  failed.emit('agent/created', { agent: failedAgent })
  assert.equal(failed.record.restrictions.length, 0)

  const foreign = createHarness()
  apply(foreign.ctx)
  const foreignAgent = foreign.makeAgent(runHistory('plan', true))
  foreign.emit('agent/created', { agent: foreignAgent })
  assert.equal(foreign.record.restrictions.length, 0)
})

test('a logged /sage off resumes inactive', () => {
  const events = [...runHistory('sage', true), ...runHistory('sage', false)]
  const harness = createHarness()
  apply(harness.ctx)
  const agent = harness.makeAgent(events)
  harness.emit('agent/created', { agent })

  assert.equal(harness.record.restrictions.length, 0)
  assert.equal(sectionText(harness), '')
})

test('agent disposal and plugin unload both lift the restriction', () => {
  const disposed = createHarness()
  apply(disposed.ctx)
  const disposedAgent = disposed.makeAgent()
  run(disposed, disposedAgent, '')
  disposed.emit('agent/disposed', { agent: disposedAgent })
  assert.equal(restriction(disposed).lifted, true)

  const unloaded = createHarness()
  apply(unloaded.ctx)
  const liveAgent = unloaded.makeAgent()
  run(unloaded, liveAgent, '')
  unloaded.unload()
  assert.equal(restriction(unloaded).lifted, true)
})

test('an unusual preset falls back to denying known mutators', () => {
  const harness = createHarness({ toolNames: ['write', 'edit', 'ops_replace', 'frobnicate'] })
  apply(harness.ctx)
  const agent = harness.makeAgent()
  run(harness, agent, '')

  assert.deepEqual(restriction(harness).filter, { deny: ['write', 'edit', 'ops_replace'] })
  const check = guard(harness).fn
  assert.match(check({ name: 'write' }), /Sage mode/)
  assert.equal(check({ name: 'frobnicate' }), undefined, 'an unknown read-only tool stays callable')
})

test('agents that already exist when the plugin loads are admitted', () => {
  const existing = { id: 'live-1', session: { snapshotEvents: () => runHistory('sage', true) } }
  const harness = createHarness({ liveAgents: [existing] })
  existing.ctx = {
    systemPrompt: { section: (section) => { harness.record.sections.push(section); return () => {} } },
    tools: harness.toolsService,
  }
  apply(harness.ctx)
  assert.equal(restriction(harness).filter.allow.includes('read'), true)
})

let failed = 0
for (const { label, fn } of tests) {
  try {
    fn()
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${label}\n      ${error.message}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} checks passed`)
if (failed > 0) process.exitCode = 1
