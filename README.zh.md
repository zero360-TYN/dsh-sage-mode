# dsh-sage-mode · 贤者模式

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai) 会话加一个**只读顾问模式**：
`/sage` 进入，`/sage off` 退出。

进入后这个会话只剩下「读 / 搜 / 联网」类工具，编辑、删除、执行命令的工具**全部从模型可见的工具表中移除**，
并在执行层兜底拒绝。同时注入一段「顾问人格」提示词，让模型回答问题并给出建议、评估、讲解、头脑风暴和报错分析，
而不是动手改代码。

名字取意 **Sage（贤者）**：智者只出主意，不替你动手。

## 为什么需要它

写代码的 Agent 天生是「动手」的。但有些时候你要的不是动手，而是理解代码、比较方案、学习概念、
头脑风暴、排查报错。贤者模式把这个意图变成一个正式的开关：Agent 仍然可以读你的仓库、搜网页，
但**碰不了任何东西**。

## 使用

| 输入 | 效果 |
|---|---|
| `/sage` | 进入贤者模式：只保留只读工具，注入顾问提示词 |
| `/sage <问题>` | 进入模式，并把这句话作为你的提问直接发出去（可带图片/文件附件） |
| `/sage off` | 退出，完整工具集立刻恢复 |

典型场景：看不懂某段实现、想学代码、需要方案对比、想头脑风暴、贴一段报错求解。
想真正动手改代码时，`/sage off` 退出即可。

客户端左上角的工具提示不会变，但**模型可见的工具集确实变了**：被隐藏的工具连 schema 都不再发送；
即使模型硬要调用，也会在执行前被 `tools.guard()` 拒绝，返回一句「先让用户运行 `/sage off`」。

## 保留的工具（默认）

`read` `read_image` `glob` `grep` `web_search` `web_fetch` `ask_user_question` `skill`
`cordis_inspect_list` `cordis_inspect_query` `load_workspace_dependencies`

其余全部隐藏：`write` `edit` `ops_replace`、`pwsh`/`bash` 与后台任务、`subagent`/`send_message`、
`plugin_manager`、`todo_write`、`present`、目标与团队任务工具等。
清单里不存在的名字会被自动忽略，因此同一份配置适用于不同 preset。

## 参考（Reference）

### 可选依赖：dsh-ops

三个高速只读工具 `ops_glob` `ops_grep` `ops_inspect_local_file` 来自独立的 bundle
**[dsh-ops](https://github.com/T-Auto/dsh-ops)**。贤者模式把它们声明为**可选依赖**
（[`cordis.patch.yml`](cordis.patch.yml) 里的 `optionalTools`）：

- **装了 dsh-ops** → 这些工具被纳入白名单，保持可用。
- **没装 dsh-ops** → 名字被忽略，其余功能完全不受影响。可选依赖缺失**从不算错误**。

想引入其它 bundle 的只读工具，扩展这张表即可，无需改代码：

```yaml
config:
  optionalTools:
    some-other-plugin: [their_read_tool]
```

### 相关链接

- [dsh-ops](https://github.com/T-Auto/dsh-ops) —— `ops_*` 工具的可选来源。
- [贤者模式仓库](https://github.com/zero360-TYN/dsh-sage-mode) —— 本插件。

## 安装

打开 Harness 的**插件市场（Plugin Manager）**，把本仓库的 URL 填进安装框：

```
https://github.com/zero360-TYN/dsh-sage-mode
```

![pic_location: /readme_pic/install.png](/readme_pic/install.png)

管理器会把 GitHub 仓库 URL 识别为 git 安装类型，克隆该包、加入 `sage-mode` 行并激活。
以后更新就是重新填一次同样的 URL；新的 JavaScript 模块代际需要重启应用才会加载。

<details>
<summary>备选方式：从本地目录安装</summary>

如果你有本地 checkout，把 target 改成绝对路径即可：

```
plugin_manager(action: "install_bundle", target: "<本仓库的绝对路径>")
```

这种方式以**链接**安装，改仓库文件就等于直接改运行中的插件——开发时更方便。

</details>

## 定制

行配置的默认值在 [`cordis.patch.yml`](cordis.patch.yml)；你自己的覆盖写在 profile 的用户层
（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）。补丁会**整段替换**目标行的 `config`，
所以要保留的键必须全部重写：

```yaml
- id: sage-mode
  name: dsh-sage-mode
  config:
    command: sage          # 命令名（默认 sage）
    sectionOrder: 3255     # 提示词段落排序
    allowedTools: [read, grep, web_search]   # 只保留这些
    optionalTools:         # 可选依赖：某插件在时才纳入它的只读工具
      dsh-ops: [ops_glob, ops_grep, ops_inspect_local_file]
    section: |             # 顾问提示词全文
      ...
```

未知键会在加载时直接报错，避免拼错后静默失效；缺失键沿用默认值。

## 实现要点

- **状态来自会话日志**：折叠命令服务本来就会记录的 `command/run` + `command/done`，
  因此**不新增自定义事件类型**——否则旧版本 reader 会拒绝重开会话。恢复会话、fork 后模式自动还原。
- **按 agent 强制生效**：`agent.ctx.tools.restrict({ allow })` 隐藏工具，`agent.ctx.tools.guard()` 兜底拒绝；
  两个 disposer 同时挂在 `agent.ctx` 和插件自己的 effect 上，agent 销毁或插件卸载都会解除。
- **零 `@deepseek-ai/*` 依赖**：profile 安装的 bundle 只能从 dsh 安装目录解析这些包，
  所以插件只使用 Node 内置模块 + 通过 `ctx` 取得的服务。
- 提示词段落注册在该 agent 自己的 scope 上，模式关闭时返回空串——闲置时不产生 token 消耗。

## 已知边界

- 只作用于**当前会话**：其它标签页/会话不受影响。
- PTC 模式下保留 `run_code` 传输本身（否则整个工具面不可用），但生成的 SDK 里只暴露被允许的只读工具。
- 计划模式（plan mode）的 `exit_plan_mode` 也会被隐藏；需要退出计划模式时先 `/plan off` 或 `/sage off`。
- 沙箱/审批策略不受本插件影响；它管的是「模型手里有没有这些工具」，不是文件系统权限。

## 自检

```powershell
node test/self-test.mjs
```

覆盖配置校验、日志折叠、命令契约、限制/守卫的注册与解除、异常组合下的兜底掩码，
以及插件加载时已存在的 agent 的补挂。

## 许可

[MIT](LICENSE)
