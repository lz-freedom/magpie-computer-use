# 架构

插件不实现 Computer Use 本身。它做四件事：把自己登记进 magpie 资源库；把 Agent 的工具调用翻译为本机 LCU 运行时的 `js` 调用；按插件选项把整个任务交给指定模型执行；把运行时的授权请求与清理交还给 magpie 与 Agent。

## 模块

| 文件 | 职责 |
| --- | --- |
| `index.mjs` | magpie 扩展入口。加载时登记资源库、启动卸载监视进程，并在后台生成设置页的模型列表。不启动 LCU。 |
| `page/` | magpie 设置页（`package.json` 的 `magpie.page`）：经页面桥 `magpie.options.get/set` 读写选项，模型下拉框来自 `page/models.js`。 |
| `src/catalog.mjs` | 从网关读取模型、从 magpie 的 `providers.json` 与 `icons/` 读取提供方名称与图标（内置图标名查 LobeHub 图标库），写入 `page/models.js`（插件页面不能联网，只能加载自己文件夹中的文件）。 |
| `bin/magpie-computer-use.mjs` | 命令行入口，分发到 `src/cli.mjs`。 |
| `src/cli.mjs` | `mcp`、`doctor`、`models`、`register`、`unregister`、`--version`。 |
| `src/config.mjs` | 版本号、LCU 最低版本（0.11.4）与已验证版本（0.13.2）、magpie 配置目录。 |
| `src/plugin-entry.mjs` | 在 `plugins.json` 中找到本插件的条目（含用户选项）。 |
| `src/options.mjs` | 插件选项的默认值、校验与读取（`model`、`tools`、`maxSteps` 等）。每次需要时重新读取。 |
| `src/gateway.mjs` | magpie 网关客户端：`/v1/models`（含图片与工具能力）与 `/v1/messages`（Anthropic 格式；上游接口由 magpie 的供应商设置决定，推理强度用 `output_config.effort` 传递）。 |
| `src/agent.mjs` | 委托执行循环：系统提示（只陈述事实）、工具定义（原版 `js` / `js_reset`）、截图自动编号为证据、MCP 结果与 Anthropic 内容互转、截图裁剪、续接会话、报告与证据格式。 |
| `agent.mjs`（根目录） | 向 magpie 声明 Agent「MCU」：按 User-Agent `MCU` 认领请求，路由与用量页面显示插件名称与图标。magpie 只允许它引用同目录文件。 |
| `src/sessions.mjs` | 委托会话（按 `session_id` 保存执行模型的对话，闲置 30 分钟失效）与证据截图落盘。 |
| `src/server.mjs` | 面向 Agent 的 MCP 服务：按 `tools` 选项暴露工具；直接工具与委托工具共用同一个 LCU 连接与上下文；授权转发；进度通知；连接关闭时结束轮次。 |
| `src/approval.mjs` | 应用授权：按 `approval` 选项处理运行时的授权请求——手动授权改写为勾选框表单，跟随 Agent 原样转交，直接允许不询问；选择换回 `_meta.persist`。 |
| `src/claude-hook.mjs` | 跟随 Agent 权限模式：Claude Code 的 PreToolUse 钩子按 tool_use_id 记录 permission_mode，MCP 处理授权询问时读出；钩子的安装与移除。 |
| `src/prompts.mjs` | MCP 指令模板 `mcu`（斜杠命令）：按客户端声明参数，把按空格切开的参数拼回完整任务。 |
| `src/tools.mjs` | 十个操作工具与两个委托工具的协议、参数校验、`js` 代码生成（用户输入只以 JSON 数据进入代码）。 |
| `src/lcu.mjs` | 发现 LCU，解析符号链接，校验平台与布局，读取版本，加载官方共享客户端。 |
| `src/library.mjs` | 资源库读写：`mcp: null` 视为空列表；只认领指向本包入口的条目；路径变化时以相同 Agent 选择重新登记。 |
| `src/doctor.mjs` | 诊断报告。 |
| `src/cleanup.mjs` | 卸载监视进程：安装记录确认移除后，撤销资源库登记并同步 Agent。 |
| `src/process.mjs` | 外部命令执行（`magpie library …`）。 |

## 委托执行

```text
Agent → computer_use({ task, session_id?, model? })
  server.mjs：读取插件选项 → 取出会话（有 session_id 时）→ 确定模型（参数优先）→ 检查模型能否接收截图并调用工具
  新会话先 js_reset；工具集 = 原始初始化指令 + 委托规则、原版 js / js_reset（原样，与 ChatGPT 相同）
  agent.mjs 循环（续接时在原对话末尾追加“后续指令”）：
    gateway.createMessage({ model, system, tools, messages })
    ← tool_use → server.executeOriginal() 原样调用 js / js_reset → LCU → 原始运行时 → tool_result（原样，不截断、不裁剪）
    ← js 返回的截图自动编号存为证据（结果末尾注明 #n），报告引用的随结果交回
    继续，直到模型给出最终回复或达到 maxSteps
  sessions.mjs：保存对话、把证据写入 $TMPDIR/magpie-computer-use/evidence/<session_id>/
  ← 结果：事实报告 + 证据清单（路径）+ 最后几张证据原图 + session_id + 步骤摘要 + token 用量

Agent → look({ app }) → get_app_state 的截图部分（不返回界面树、不做操作）
```

每个 MCP 连接最多开两个 LCU 运行时连接：`agent` 供 Agent 直接操作（十个包装工具，或 `direct: "original"` 时的原版 `js` / `js_reset`），`delegate` 供执行模型与 `look`。运行时的 JS 环境是全局的，委托会话开始时的 `js_reset` 因此不会清掉 Agent 自己的变量；两个连接共用授权转发，连接关闭时各自结束用过的轮次。执行模型以委托会话为轮次（`turnId` 即 `session_id`），Agent 的直接操作以连接或宿主轮次为轮次。

## 授权与轮次

- 运行时的授权请求经 `relayElicitation` 转交给调用方 Agent（需要 Agent 声明 elicitation 能力）；否则取消。
- 针对 `com.yetone.magpie` 的请求直接拒绝；LCU 客户端自身的宿主守卫也会拒绝 Agent 宿主应用。
- 身份：宿主提供 `_meta['x-codex-turn-metadata']` 中的 `session_id` 与 `turn_id` 时沿用；否则整条 MCP 连接共用一个上下文。
- 连接关闭时，对用过的每个身份调用 `turnEnded('Stop')`，再关闭 LCU 客户端。
