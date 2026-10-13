/**
 * Sage mode — a user-toggled read-only advisory mode for one session.
 *
 * `/sage` turns the session into the user's thinking partner: answer, advise,
 * evaluate, teach, brainstorm, and diagnose. While the mode is active the
 * session receives one advisory prompt section, the mutating tools are hidden
 * from that agent, and a guard denies anything that still reaches execution.
 * `/sage off` restores the full toolset.
 *
 * Mechanics:
 * - State is *derived from the session log* — the `command/run`/`command/done`
 *   pair the commands service already writes for `/sage` — so a resume or fork
 *   recovers the mode without appending a plugin-owned event type (which older
 *   readers would refuse to reopen).
 * - Enforcement is per agent: `agent.ctx.tools.restrict()` hides tools and
 *   `agent.ctx.tools.guard()` denies calls, both owned by `agent.ctx` and kept
 *   in this plugin's own disposer, so agent disposal and plugin unload both
 *   unwind them.
 * - This module deliberately imports no `@deepseek-ai/*` value. A
 *   profile-installed bundle resolves those only from the dsh installation, so
 *   the plugin stays on Node builtins plus services reached through `ctx`.
 *
 * @module dsh-sage-mode
 */
import { randomUUID } from 'node:crypto'

/** Cordis plugin name (the loader row's `name` resolves this package). */
export const name = 'dsh-sage-mode'

/** Command name unless the row config overrides it. */
const DEFAULT_COMMAND = 'sage'
/** Prompt section name; one registration per agent scope. */
const SECTION_NAME = 'sage:policy'
/** Default placement: just after dsh-ops' repository-tooling sections (3250-3252). */
const DEFAULT_SECTION_ORDER = 3255
/** PTC mode's presentation transport is never restrictable, so the guard admits it. */
const PTC_TRANSPORT = 'run_code'
/** Accepted config keys; anything else fails at load instead of being ignored. */
const CONFIG_KEYS = new Set(['command', 'section', 'sectionOrder', 'allowedTools'])

/**
 * Tools that stay visible in Sage mode: reading, searching, web, plus the
 * read-only runtime inspection helpers. Names absent from a composition are
 * ignored, so one list works across presets.
 */
const DEFAULT_ALLOWED_TOOLS = Object.freeze([
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'ask_user_question',
  'skill',
  'ops_glob',
  'ops_grep',
  'ops_inspect_local_file',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'load_workspace_dependencies',
])

/**
 * Fallback mask for a composition where none of {@link DEFAULT_ALLOWED_TOOLS}
 * is visible (an unusual preset): deny the known mutators instead, so an
 * unrecognized read-only tool is not hidden along with everything else.
 */
const FALLBACK_DENIED_TOOLS = Object.freeze([
  'write',
  'edit',
  'ops_replace',
  'str_replace_editor',
  'bash',
  'pwsh',
  'bash_persistent',
  'pwsh_persistent',
  'run_background',
  'ops_run_background',
  'plugin_manager',
  'present',
  'todo_write',
])

/** Fallback guidance, used when a row supplies no `section`. */
const DEFAULT_SECTION = `You are in Sage mode: for this session you are the user's thinking partner — answer, advise, evaluate, teach, brainstorm, and diagnose. You do not change the workspace.

Do not edit, create, delete, move, or rename files, and do not run commands that mutate anything. Every mutating tool is hidden and denied while this mode is active. If the user's request would require a change, do not silently refuse: explain exactly what you would change and why, then tell them to run /sage off to have it carried out.

Ground every answer in evidence. Read the real files, search the repository and the web, and cite paths with line numbers. Keep what you verified by reading separate from what you are inferring, and say which is which.

Answer the question first, then add the advice that matters: options with their trade-offs, a recommendation, the risks, and the next concrete step.

- Explaining an implementation: trace the actual path — entry point, data flow, where state lives, what the effects are — naming files and functions; stop as soon as the question is answered.
- Teaching code: build from what the user already knows, show one small illustrative snippet in the reply (never written to a file), and check understanding with a question when it helps.
- Evaluating or reviewing: state the criteria, list findings by severity with evidence, then give a verdict and the fixes in priority order.
- Brainstorming: offer several genuinely different directions, name the constraint each one assumes, and ask which to explore.
- Diagnosing an error: establish the root cause from the evidence, explain why it happens, then give the fix as instructions the user can apply.

Ask a clarifying question only when the decision is genuinely the user's or cannot be discovered by reading. Prefer inspecting the code over asking where something lives.

Format for a chat reply: short paragraphs, lists, and fenced code blocks. Reply in the user's language. Never claim to have changed anything.`

/**
 * Validate the row config. Unknown keys fail loudly; a missing key keeps its
 * default so a user layer may override only what it cares about.
 *
 * @param raw - the row's raw `config` object.
 * @returns the validated config.
 */
function resolveConfig(raw) {
  const config = raw ?? {}
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('sage-mode: config must be a mapping of { command, section, sectionOrder, allowedTools }')
  }
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(`sage-mode: unknown config key(s) ${unknown.join(', ')} — config is { command, section, sectionOrder, allowedTools }`)
  }
  const command = typeof config.command === 'string' && config.command.trim() !== ''
    ? config.command.trim().replace(/^\//, '')
    : DEFAULT_COMMAND
  const section = typeof config.section === 'string' && config.section.trim() !== '' ? config.section : DEFAULT_SECTION
  const sectionOrder = Number.isFinite(config.sectionOrder) ? config.sectionOrder : DEFAULT_SECTION_ORDER
  const allowedTools = Array.isArray(config.allowedTools)
    ? [...new Set(config.allowedTools.filter((entry) => typeof entry === 'string' && entry.trim() !== ''))]
    : [...DEFAULT_ALLOWED_TOOLS]
  return { command, section, sectionOrder, allowedTools }
}

/** The `/sage off` spelling, case-insensitive and exact. */
function isOffArgument(value) {
  return String(value ?? '').trim().toLowerCase() === 'off'
}

/**
 * Fold the session log for this mode: the commands service logs `command/run`
 * before the handler and `command/done` after it, so the last successfully
 * settled run of this command names the state.
 *
 * @param session - the agent's session, when it exposes its log.
 * @param command - the command name this plugin owns.
 * @returns whether Sage mode is active for that session.
 */
function foldActive(session, command) {
  if (session === undefined || typeof session.snapshotEvents !== 'function') return false
  let active = false
  let running
  for (const event of session.snapshotEvents()) {
    const data = event?.data
    if (event?.type === 'command/run') {
      if (data?.name !== command) continue
      running = { commandId: data.commandId, wanted: !isOffArgument(data.args) }
      continue
    }
    if (event?.type === 'command/done') {
      if (running === undefined || data?.commandId !== running.commandId) continue
      if (data.kind === 'success') active = running.wanted
      running = undefined
    }
  }
  return active
}

/**
 * Register the Sage-mode plugin.
 *
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the row config, validated here.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  /** Per-agent state: mode flag, own disposers, and the admitted tool set. */
  const entries = new Map()

  const report = (level, message) => {
    const logger = ctx?.logger
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](message)
  }
  const warn = (message) => report('warn', message)

  const offHint = () => `/${config.command} off`
  const denialText = () => `Sage mode is active: this session has read, search, and web tools only. Explain what you would change and why instead, and let the user run ${offHint()} to carry it out.`

  /** Names the calling agent can currently see, or `[]` when unavailable. */
  const visibleNames = (agent) => {
    try {
      const tools = ctx.get('tools')
      if (tools === undefined || typeof tools.schemas !== 'function') return []
      return (tools.schemas(agent) ?? []).map((schema) => schema?.name).filter((entry) => typeof entry === 'string')
    } catch (error) {
      warn(`sage-mode: could not read the visible tool set: ${error.message}`)
      return []
    }
  }

  /** Create the per-agent entry, registering its prompt section once. */
  const ensure = (agent) => {
    const existing = entries.get(agent)
    if (existing !== undefined) return existing
    const entry = {
      active: foldActive(agent?.session, config.command),
      section: undefined,
      lift: undefined,
      guard: undefined,
      admitted: undefined,
    }
    entries.set(agent, entry)
    try {
      entry.section = agent.ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: config.sectionOrder,
        interpolate: false,
        text: () => (entry.active === true ? config.section : ''),
      })
    } catch (error) {
      warn(`sage-mode: no prompt section for this session (${error.message}); enforcement still applies.`)
    }
    return entry
  }

  /** Hide the mutating tools and deny anything else that still reaches dispatch. */
  const engage = (agent, entry) => {
    if (entry.lift !== undefined || entry.guard !== undefined) return
    const tools = agent?.ctx?.tools
    if (tools === undefined) {
      warn('sage-mode: this agent exposes no tools service; Sage mode cannot restrict its tools.')
      return
    }
    const visible = visibleNames(agent)
    const visibleSet = new Set(visible)
    const allowed = config.allowedTools.filter((tool) => visibleSet.has(tool))
    let filter
    if (allowed.length > 0) {
      entry.admitted = new Set([...allowed, PTC_TRANSPORT])
      filter = { allow: allowed }
    } else {
      const denied = FALLBACK_DENIED_TOOLS.filter((tool) => visibleSet.has(tool))
      entry.admitted = new Set([...visible.filter((tool) => !denied.includes(tool)), PTC_TRANSPORT])
      filter = { deny: denied }
      warn(`sage-mode: none of the configured read-only tools is visible here; denying ${denied.length} known mutating tool(s) instead.`)
    }
    try {
      entry.lift = tools.restrict(filter)
    } catch (error) {
      warn(`sage-mode: could not hide tools for this session (${error.message}); the guard still denies them.`)
    }
    try {
      entry.guard = tools.guard((exec) => (entry.admitted?.has(String(exec?.name ?? '')) === true ? undefined : denialText()))
    } catch (error) {
      warn(`sage-mode: could not register the denial guard (${error.message}).`)
    }
  }

  /** Lift every restriction this plugin owns for one agent. */
  const release = (entry) => {
    try {
      entry.lift?.()
    } catch (error) {
      warn(`sage-mode: lifting the tool restriction failed: ${error.message}`)
    }
    try {
      entry.guard?.()
    } catch (error) {
      warn(`sage-mode: lifting the denial guard failed: ${error.message}`)
    }
    entry.lift = undefined
    entry.guard = undefined
    entry.admitted = undefined
  }

  /** Apply one state to one agent; returns whether the state changed. */
  const setActive = (agent, active) => {
    const entry = ensure(agent)
    if (entry.active === active) return false
    entry.active = active
    if (active) engage(agent, entry)
    else release(entry)
    return true
  }

  /** Hand a submitted `/sage <message>` to the session as the next input. */
  const steer = (agent, content) => {
    try {
      if (typeof agent?.steer !== 'function') return false
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content,
        source: { kind: 'user' },
      })
      return true
    } catch (error) {
      warn(`sage-mode: could not hand the message to the session: ${error.message}`)
      return false
    }
  }

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: config.command,
      description: 'Enter or leave Sage mode: advice, review, explanation, brainstorming, and error analysis with read-only tools',
      input: { hint: '[off|message]', attachments: true },
      handler: ({ agent, rawInput, attachments }) => {
        const entry = ensure(agent)
        const text = String(rawInput ?? '').trim()
        const blocks = Array.isArray(attachments) ? attachments : []
        if (isOffArgument(text)) {
          if (blocks.length > 0) {
            return { kind: 'error', text: `Attachments cannot accompany ${offHint()}.` }
          }
          if (entry.active !== true) {
            return { kind: 'success', text: `Sage mode is already off. Enter it with /${config.command}.` }
          }
          setActive(agent, false)
          return { kind: 'success', text: `Sage mode off — the full toolset is available again.` }
        }
        const wasActive = entry.active === true
        if (!wasActive) setActive(agent, true)
        const on = `Sage mode on — read, search, and web tools only; answer, advise, evaluate, and explain. Leave it with ${offHint()}.`
        const content = [...blocks, ...(text === '' ? [] : [{ type: 'text', text }])]
        if (content.length === 0) {
          return { kind: 'success', text: wasActive ? 'Sage mode is already on.' : on }
        }
        const handed = steer(agent, content)
        return {
          kind: 'success',
          text: handed
            ? wasActive ? 'Sage mode is on; your message was sent.' : on
            : `Sage mode is on, but the message could not be handed over — send it as your next turn. Leave with ${offHint()}.`,
        }
      },
    }), 'dsh-sage-mode: mode command')
  })

  const admit = (agent) => {
    const entry = ensure(agent)
    if (entry.active === true) engage(agent, entry)
  }

  ctx.on('agent/created', ({ agent }) => admit(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const entry = entries.get(agent)
    if (entry === undefined) return
    release(entry)
    try {
      entry.section?.()
    } catch (error) {
      warn(`sage-mode: dropping the prompt section failed: ${error.message}`)
    }
    entries.delete(agent)
  })
  ctx.effect(() => () => {
    for (const entry of entries.values()) {
      release(entry)
      try {
        entry.section?.()
      } catch {
        /* the agent scope is going away with the plugin */
      }
    }
    entries.clear()
  }, 'dsh-sage-mode: per-agent registrations')

  for (const agent of ctx.get('agents')?.list?.() ?? []) admit(agent)
}
