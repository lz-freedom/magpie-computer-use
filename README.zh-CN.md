# MCU（magpie Computer Use）

[English](README.md)

[magpie](https://usemagpie.ai) 插件：让 magpie 里的 Agent（Claude Code、Codex 等）通过 ChatGPT 桌面应用自带的 Computer Use 运行时操作 macOS 应用。

Agent 有两种用法：

- **委托：** 把整个任务交给你在 magpie 里选的模型（例如 GPT-6.1 Terra）。它的操作方式与在 ChatGPT 里完全相同，完成后交回事实报告和带标签的证据截图，由 Agent 自己下结论。
- **直接操作：** Agent 自己用 ChatGPT 原版的 `js` / `js_reset` 工具一步步操作。

## 准备

- Apple Silicon Mac，magpie 0.1.2075 或更新
- [ChatGPT 桌面应用](https://chatgpt.com/download/)，装在 `/Applications/ChatGPT.app`（不用登录）
- [LCU](https://github.com/amontlabs/lcu) 0.11.4 或更新（已在 0.13.2 上验证），负责在 ChatGPT 之外运行它的 Computer Use 运行时，安装步骤见下
- 用户目录名不超过 13 个字符（`/Users/<名字>`），ChatGPT 的 Computer Use 辅助程序不接受更长的路径
- Node.js 22 或更新，只在运行 `doctor` 和测试时需要；插件本身由 magpie 自带的 Bun 运行

## 安装

### 让 Agent 帮你装

把下面这段发给 Mac 上的 Claude Code、Codex 等 Agent：

```text
帮我在这台 Mac 上安装 magpie 插件 MCU（https://github.com/lz-freedom/magpie-computer-use），每一步确认成功后再做下一步：

1. 确认这是 Apple Silicon Mac，`magpie --version` 是 0.1.2075 或更新，并且 /Applications/ChatGPT.app 存在。缺哪个就告诉我并停下，不要替我安装。
2. 如果 ~/.local/share/lcu/current/bin/lcu 不存在，按 https://github.com/amontlabs/lcu/blob/main/docs/INSTALLATION.md 安装 LCU：从最新 release 下载 darwin-arm64 安装包和对应的 .sha256，校验通过后在解压目录运行 `./scripts/install.sh --runtime-only --yes`。MCU 只用它的运行时，不要把 LCU 注册到任何 Agent。
3. 运行 `magpie plugin add github:lz-freedom/magpie-computer-use`。
4. 运行 `~/.local/share/lcu/current/bin/lcu doctor`；如果有 Node.js 22 或更新，再运行 `node ~/.config/magpie/plugins/node_modules/magpie-computer-use/bin/magpie-computer-use.mjs doctor`。有失败就把提示原文告诉我。
5. 告诉我还需要我做什么：在 magpie 的 资源库 → MCP 服务器 → magpie-computer-use 里勾选我的 Agent，在 插件 → MCU 选择执行模型，然后重启这些 Agent，第一次使用时同意 macOS 的权限请求。
```

### 手动安装

1. **安装 LCU**（已有 `~/.local/share/lcu/current/bin/lcu` 可跳过）。下载最新版本，校验后只安装运行时：

   ```sh
   (
     set -e
     [ "$(uname -sm)" = "Darwin arm64" ] || { echo "MCU 只支持 Apple Silicon Mac" >&2; exit 1; }
     LCU_TAG=$(curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/amontlabs/lcu/releases/latest); LCU_TAG=${LCU_TAG##*/}
     LCU_ARCHIVE="lcu-${LCU_TAG#v}-darwin-arm64.tar.gz"
     mkdir -p lcu-release && cd lcu-release
     curl -fLO "https://github.com/amontlabs/lcu/releases/download/$LCU_TAG/$LCU_ARCHIVE"
     curl -fLO "https://github.com/amontlabs/lcu/releases/download/$LCU_TAG/$LCU_ARCHIVE.sha256"
     shasum -a 256 -c "$LCU_ARCHIVE.sha256"
     tar -xzf "$LCU_ARCHIVE" && cd "${LCU_ARCHIVE%.tar.gz}"
     ./scripts/install.sh --runtime-only
   )
   ~/.local/share/lcu/current/bin/lcu doctor
   ```

   不是 Apple Silicon Mac 或校验不通过时会直接停下。`--runtime-only` 只安装 LCU，不把它注册到任何 Agent；MCU 直接调用它。

2. **安装插件：**

   ```sh
   magpie plugin add github:lz-freedom/magpie-computer-use
   ```

3. **启用：**
   - 在 **资源库 → MCP 服务器 → magpie-computer-use** 里勾选要用它的 Agent。
   - 到侧边栏 **插件 → MCU** 选择执行模型。
   - 重启这些 Agent。第一次操作某个应用时，同意 macOS 的权限请求（辅助功能、屏幕录制）和 MCU 的应用授权。

## 使用

对 Agent 说“用 mcu …”，例如：

```text
用 mcu 在备忘录里新建一条笔记，标题“明天待办”
用 mcu 打开 A、B 两个页面，各截一张首页给我，我来比较哪个好看
```

Claude Code 里也可以输入 `/mcu`，选 `magpie-computer-use:mcu (MCP)`，后面直接写任务，不加引号。

## 功能

### 工具

| 工具 | 作用 |
| --- | --- |
| `computer_use` | 把任务交给执行模型。`task` 必填，可选 `app`、`session_id`、`model`、`max_steps`、`max_images`、`include_screenshot` |
| `look` | 只截图，不做任何操作 |
| `list_computer_use_models` | 列出能执行委托的模型（要能接收截图、调用工具） |
| `js`、`js_reset` | 直接操作，ChatGPT 原版工具（默认） |
| `list_apps`、`get_app_state`、`click`、`set_value`、`select_text`、`scroll`、`drag`、`press_key`、`type_text`、`perform_secondary_action` | 十个单步直接操作工具，`direct` 设为 `wrapped` 时代替 `js` |

### 委托是怎么进行的

1. **执行模型只操作、只陈述事实。** 它拿到的指令、`js` / `js_reset` 工具和返回内容与在 ChatGPT 里相同，另加一段委托说明，没有别的工具。报告只写做了什么、看到了什么、还有什么没完成，不做评价。
2. **截图作为证据交回。** `js` 返回的每张截图都自动编号，保存在 `$TMPDIR/magpie-computer-use/evidence/<session_id>/`，不多花一轮模型往返。报告在事实旁边引用编号（`#3`），被引用的原图随报告附上；没有引用时附最后一张。
3. **Agent 下结论，也可以接着指挥。** 带上返回的 `session_id` 再调用，执行模型在原来的画面上继续，闲置 30 分钟失效。Agent 也可以用 `look` 自己看一眼屏幕。

执行模型经 magpie 网关的 `/v1/messages` 调用，在路由与用量页面里显示为 **MCU**。

上游用哪种接口（Messages、Chat Completions 或 Responses）由 magpie 中该模型的供应商设置决定。GPT 模型建议在供应商里只填 Responses 地址，然后重启 magpie。这样推理内容能在步骤之间延续，提示缓存也能生效。实测比转成 Chat Completions 快约 4 倍，费用约为 1/3。

## 设置（插件 → MCU）

- **提供给 Agent 的工具：**
  - 由 Agent 选择（默认）：两种工具都给 Agent。
  - 只用委托：每次都由执行模型操作。
  - 只用直接操作：Agent 自己操作。

  修改后要在 Agent 中重连 MCP，或新开会话。
- **执行模型**（选“只用直接操作”时隐藏）：
  - 默认模型
  - 推理强度
  - 最多步数
  - 每次随报告回传几张截图
- **使用 Chrome 扩展操作网页**，默认关闭：开启后执行模型和 Agent 拿到 ChatGPT 原版的浏览器 API，直接操作 Chrome 标签页，不用把 Chrome 当普通应用一点点点击。MCU 以 `--chrome` 启动 LCU，必要时运行 `lcu browser install`，让 Chrome 里的 ChatGPT 扩展经 LCU 连接（ChatGPT 应用自己的 Chrome 功能照常可用）。[ChatGPT 扩展](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg) 需要你自己在 Chrome 里安装并启用；第一次开启后重启 Chrome，或在 `chrome://extensions` 把扩展关掉再打开。设置页会显示连接器和扩展的状态，点「重新检测」可再检查一次（约 15 秒）。每个网站第一次访问时按下面的应用授权方式询问。
- **应用授权：**
  - 手动授权（默认）：第一次操作某个应用时询问，可选仅这一次、本次会话或始终允许。
  - 跟随 Agent 权限模式：适用于 Claude Code，会在 `~/.claude/settings.json` 里加一个只属于本插件的钩子。bypass 和 auto 直接允许，默认与 accept edits 询问，plan 拒绝。
  - 所有应用直接允许：不询问，也不写入永久授权。

  终端、Agent 宿主应用和 magpie 本身始终不会被批准。

这些设置也可以用命令修改，例如 `magpie plugin options magpie-computer-use '{"model":"provider/model"}'`：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `model` | 未设置 | 执行模型（`provider/model`） |
| `tools` | `both` | `both`、`delegate` 或 `direct` |
| `direct` | `original` | 直接操作的工具：`original`（`js` / `js_reset`）或 `wrapped`（十个工具） |
| `executorEffort` | `medium` | `auto`（不指定）、`low`、`medium`、`high`、`xhigh`、`max` |
| `maxSteps` | `40` | 一次委托最多的模型轮数（1–200） |
| `evidenceImages` | `4` | 随报告回传的截图张数（0–10），其余只给文件路径 |
| `approval` | `manual` | `manual`、`agent` 或 `auto`；浏览器模式下 `auto` 也直接允许网站 |
| `chrome` | `false` | 浏览器模式：以 `--chrome` 启动 LCU（必要时运行 `lcu browser install`） |
| `delegateVia` | `api` | `api`：由 MCU 调用执行模型；`codex`：交给 Codex（`codex exec` 加官方 Computer Use 插件），`codexPath` 可指定程序路径 |
| `maxTokens` | `32000` | 执行模型每轮最多输出的 token，包括推理 |
| `gatewayUrl`、`gatewayKey` | 本机网关 | 一般不用改 |

## 读取与写入

- **magpie 配置目录**（`~/.config/magpie`）：
  - 读取 `plugins.json`（本插件的选项），以及 `providers.json` 和 `icons/`（设置页的模型列表）
  - 在 `library.json` 里登记本插件的 MCP 服务器，移除插件时自动撤销
- **magpie 网关**（`127.0.0.1:3425`）：任务和截图经 magpie 发给你选的模型。
- **LCU 与 ChatGPT 应用的 Computer Use 运行时**：负责操作应用，应用授权仍由你决定。
- **`$TMPDIR/magpie-computer-use/`**：证据截图，保留一天。
- **Chrome 的原生消息主机**（只在浏览器模式下）：`lcu browser install` 把 ChatGPT 扩展的主机指向 LCU 的中转。
- **`~/.claude/settings.json`**：只有选择“跟随 Agent 权限模式”时才写入，而且只写本插件自己的钩子。
- **设置页**：只通过 `_magpie/bridge.js` 读写本插件的选项，不联网。

插件不注册供应商、不要求登录，也不保存任何凭据。

## 已知限制

- 只支持 Apple Silicon 上的 macOS，依赖 ChatGPT 应用的 Computer Use 运行时和 LCU。
- 任务运行时你自己使用同一个应用，可能把它的窗口切到后面，干扰任务。
- 可以操作 iPhone 镜像，但手机要锁屏；滑动通过 `scroll` 完成。

## 排查问题

```sh
MCU=~/.config/magpie/plugins/node_modules/magpie-computer-use/bin/magpie-computer-use.mjs
node $MCU doctor            # 检查 magpie、网关、默认模型、LCU 与 ChatGPT 应用
node $MCU doctor --live     # 额外连接一次 LCU 运行时
~/.local/share/lcu/current/bin/lcu doctor   # LCU 自己的检查
```

| 提示 | 处理 |
| --- | --- |
| 没有可用的模型 | 在 插件 → MCU 选择执行模型 |
| 无法连接 magpie 网关 | 确认 magpie 在运行 |
| 找不到可用的 LCU | 安装 LCU，或用 `MAGPIE_CU_LCU` 指向它 |
| `Computer Use was not approved to use <应用>` | 运行 `lcu apps allow <应用>` |
| 已达到步数上限 | 带上 `session_id` 继续，或调大最多步数 |
| 设置页还是旧的 | 在 magpie 窗口按 ⌘R |

## 测试

```sh
npm install
npm test
node bench/run.mjs --agent provider/model    # 在真实应用上对比委托 / 原版 js / 十个工具，结果见 bench/REPORT.md
```

## 许可

MIT，第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
