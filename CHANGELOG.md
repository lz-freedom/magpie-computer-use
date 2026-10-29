# 变更记录

## 0.1.0

- 委托执行：新增 `computer_use` 工具，把用自然语言描述的任务交给指定模型。模型经 magpie 网关（Anthropic Messages 格式，Claude、GPT 等均可）驱动十个操作工具，完成后只返回文字报告；截图不进入调用方上下文。支持步数上限、截图保留张数、进度通知、取消，以及在报告中给出未授权应用的 `lcu apps allow` 命令。
- 模型选择：插件选项 `model` 设置默认执行模型（`magpie plugin options magpie-computer-use '{"model":"provider/model"}'`），单次调用可用 `model` 参数覆盖；修改立即生效。新增 `list_computer_use_models` 工具与 `models` 命令，按网关声明筛选能接收截图并调用工具的模型；不支持的模型在执行前被拒绝。
- 设置页：magpie 侧边栏 **插件 → Computer Use**，界面沿用 magpie 的样式。模型选择器与 magpie 一致：搜索与任意 ID 输入、提供方侧栏、按提供方分组、提供方图标、1M 与免费标记、键盘操作；另有步数与截图步进、工具暴露选择；修改自动保存到与 `magpie plugin options` 相同的选项。模型列表、提供方名称与图标在插件加载时从 magpie 的网关与提供方配置生成，大图标用系统 sips 缩小。
- 斜杠命令：MCP 指令模板 `mcu`（Claude Code 中为 `/mcp__magpie-computer-use__mcu`），命令后直接写任务；为 Claude Code 额外接住按空格切开的参数并拼回完整任务。工具说明中写明简称 mcu。
- 应用授权：把运行时的授权请求改写为带“授权范围”的表单（本次会话允许、始终允许、仅这一次、拒绝），并把选择以 `_meta.persist` 回传。此前客户端只能回答“接受”，运行时当作仅此一次，每一步操作都会重新询问。
- 应用授权方式：插件选项 `approval`（设置页“应用授权”）可选手动授权、跟随 Agent、所有应用直接允许；手动授权的询问把授权范围改为逐项显示的勾选框（Claude Code 会把单选折叠）。
- 网关请求以 `MCU` 标识（User-Agent），magpie 路由与用量页面单独显示本插件的请求（此前以 magpie- 开头的名字被前缀匹配归到 magpie 自身）。侧边栏页面改名为 MCU，新增插件图标。
- 侧边栏页面图标：`page.icon` 按 magpie 的要求改为插件内的文件路径（`page/icon.svg`，内嵌插件图标），此前填 data URI 不生效、显示为拼图图标。
- 向 magpie 声明 Agent「MCU」（`agent.mjs`，按 User-Agent 认领请求），路由图与用量页面中的 MCU 显示插件图标。换用新的插件图标。
- 执行与判断分开：执行模型新增 `capture` 工具，把对比、外观、核对结果相关的画面带标签交给 Agent；报告改为只陈述事实（做了什么 / 看到的事实 / 未完成），不替 Agent 下结论。证据截图存到临时目录，最后几张原图随结果附上（选项 `evidenceImages`，参数 `max_images`）。
- 与 ChatGPT 完全一致的操作方式：执行模型拿到原始运行时的初始化指令和原版 `js` / `js_reset` 工具，调用与结果原样转交，不截断、不裁剪截图；每个新委托会话先 `js_reset`，从头拿到完整指南。执行模型不再使用插件包装的十个单步工具（同一任务实测耗时 32 秒对 64 秒、工具调用 10 次对 20 次），选项 `keepScreenshots` 随之去掉。
- `capture` 可以和截图的那次 `js` 放在同一轮，不多花一轮模型往返。
- 设置页顺序改为：提供给 Agent 的工具 → 执行模型（只用直接操作时隐藏）→ 应用授权；“两种都提供”改名为“由 Agent 选择”。README 精简重写。
- Agent 直接操作可选用 ChatGPT 原版 `js` / `js_reset`（选项 `direct: "original"`）；委托与 `look` 改用单独的运行时连接，不再清掉 Agent 自己的 JS 环境。新增对比评测 `bench/run.mjs`（10 个任务，三种方式）。
- 多轮委托：`computer_use` 返回 `session_id`，带上它再调用即在同一会话上继续；新增只截图不操作的 `look` 工具。设置页新增“回传截图”；“提供给 Agent 的工具”每一项可展开详情，说明 Agent 拿到哪些工具、委托时如何分工。
- 跟随 Agent 权限模式：通过 Claude Code 的 PreToolUse 钩子读取每次调用的 permission_mode（MCP 协议不传递），bypass/auto 直接允许，默认/accept edits 询问，plan/dontAsk 拒绝；新增 `claude-hook install|uninstall` 命令。
- 浏览器模式（设置页“使用 Chrome 扩展操作网页”，选项 `chrome`，默认关闭）：以 `lcu --chrome` 启动运行时，执行模型与 Agent 拿到 ChatGPT 原版的浏览器 API；连接器没指向 LCU 时自动运行 `lcu browser install`；设置页与 `doctor` 显示连接器和扩展状态；开关切换后下一次调用重建运行时；网站访问授权按应用授权方式处理。
- 执行模型的工具与 ChatGPT 完全一致，只有原版 `js` / `js_reset`：去掉 `capture`，`js` 返回的截图自动编号存为证据（结果末尾注明 #n），报告引用的编号随结果交回原图。此前约四分之一的步数花在单独一轮的 `capture` 上；计算器任务从 5 次工具调用降到 2 次，与 ChatGPT 应用相同。
- 执行模型统一经 magpie 网关的 `/v1/messages` 调用，上游接口（Messages / Chat Completions / Responses）由 magpie 的供应商设置决定，插件不再自行选择接口；设置页给出 GPT 模型改用 OpenAI Responses 的建议。新增推理强度设置（选项 `executorEffort`，设置页“推理强度”），以 `output_config.effort` 交给 magpie；`maxTokens` 默认改为 32000。Agent 直接操作默认改用 ChatGPT 原版 `js` / `js_reset`（`direct: "original"`），十个包装工具保留为 `direct: "wrapped"`。新增交给 Codex 执行的委托方式（`delegateVia: "codex"`）。
- 工具暴露：插件选项 `tools` 选择 `delegate`、`direct` 或 `both`。
- 十个直接操作工具：经本机已安装 LCU 的官方共享客户端调用原始运行时；LCU 在首次需要时发现与连接，按 `MAGPIE_CU_LCU`、`LCU_PREFIX`/默认位置、PATH 查找并校验，要求 0.11.4 或更新版本。
- magpie 集成：加载时自动登记资源库 MCP（`"mcp": null` 视为空列表；路径变化时刷新并保留 Agent 选择；不覆盖同名的其他 MCP）；移除插件后自动撤销登记。
- 诊断：`doctor` 检查资源库登记、插件选项、magpie 网关与默认模型、LCU 与 ChatGPT 应用，`--live` 连接运行时；`npm run smoke` 支持 `--task` 实际执行委托任务。
