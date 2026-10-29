# MCU (magpie Computer Use)

[中文](README.zh-CN.md)

A [magpie](https://usemagpie.ai) plugin that lets your agents (Claude Code, Codex and the others magpie connects) operate macOS apps through the Computer Use runtime of the ChatGPT desktop app.

An agent can do it in two ways:

- **Delegate.** The agent hands the whole task to a model you pick in magpie, for example GPT-6.1 Terra. That model operates the apps exactly as it does inside ChatGPT, then sends back a factual report and labelled screenshots. The agent draws its own conclusions.
- **Operate directly.** The agent uses ChatGPT's own `js` / `js_reset` tools itself, step by step.

## Requirements

- An Apple Silicon Mac with magpie 0.1.2075 or newer
- The [ChatGPT desktop app](https://chatgpt.com/download/) in `/Applications/ChatGPT.app` (no sign-in needed)
- [LCU](https://github.com/amontlabs/lcu) 0.11.4 or newer (tested on 0.13.2). It runs the ChatGPT app's Computer Use runtime outside ChatGPT. Install steps are below.
- A home folder name of 13 characters or fewer (`/Users/<name>`). ChatGPT's Computer Use helper refuses longer paths.
- Node.js 22 or newer, only for `doctor` and the tests. magpie runs the plugin on its own Bun.

## Install

### Let your agent do it

Paste this to Claude Code, Codex or another agent on the Mac:

```text
Install the magpie plugin MCU (https://github.com/lz-freedom/magpie-computer-use) on this Mac. Check that each step worked before the next one.

1. Check that this is an Apple Silicon Mac, that `magpie --version` is 0.1.2075 or newer, and that /Applications/ChatGPT.app exists. If anything is missing, tell me and stop; don't install it for me.
2. If ~/.local/share/lcu/current/bin/lcu doesn't exist, install LCU as https://github.com/amontlabs/lcu/blob/main/docs/INSTALLATION.md says: download the darwin-arm64 archive and its .sha256 from the latest release, verify the checksum, then run `./scripts/install.sh --runtime-only --yes` in the extracted folder. MCU uses only the runtime, so don't register LCU with any agent.
3. Run `magpie plugin add github:lz-freedom/magpie-computer-use`.
4. Run `~/.local/share/lcu/current/bin/lcu doctor`. If Node.js 22+ is available, also run `node ~/.config/magpie/plugins/node_modules/magpie-computer-use/bin/magpie-computer-use.mjs doctor`. Report any failure with its message.
5. Tell me what is left for me: in magpie, tick my agents under Library › MCP servers › magpie-computer-use, pick a model under Plugins › MCU, then restart the agents and approve macOS's permission prompts on first use.
```

### By hand

1. **Install LCU** (skip if `~/.local/share/lcu/current/bin/lcu` exists). Download the latest release, check it, and install only the runtime:

   ```sh
   (
     set -e
     [ "$(uname -sm)" = "Darwin arm64" ] || { echo "MCU only supports Apple Silicon Macs" >&2; exit 1; }
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

   It stops on anything but an Apple Silicon Mac, or if the checksum fails. `--runtime-only` installs LCU without registering it with any agent; MCU talks to it directly.

2. **Install the plugin:**

   ```sh
   magpie plugin add github:lz-freedom/magpie-computer-use
   ```

3. **Turn it on:**
   - Under **Library › MCP servers › magpie-computer-use**, tick the agents that should get it.
   - Under **Plugins › MCU** in the sidebar, pick the model that runs delegated tasks.
   - Restart those agents. The first time an app is used, approve macOS's permission prompts (Accessibility, Screen Recording) and MCU's app approval.

## Use

Ask the agent to "use mcu …", for example:

```text
use mcu to create a note in Notes titled "Tomorrow"
use mcu to open pages A and B and screenshot each home page; I'll compare them
```

In Claude Code you can also type `/mcu`, pick `magpie-computer-use:mcu (MCP)`, and write the task after it, without quotes.

## What it does

### Tools

| Tool | What it does |
| --- | --- |
| `computer_use` | Delegates a task to the chosen model. `task` is required. Optional: `app`, `session_id`, `model`, `max_steps`, `max_images`, `include_screenshot` |
| `look` | Takes a screenshot of an app. Changes nothing |
| `list_computer_use_models` | Lists the models that can run delegated tasks (they must accept images and call tools) |
| `js`, `js_reset` | Direct operation with ChatGPT's own tools (the default) |
| `list_apps`, `get_app_state`, `click`, `set_value`, `select_text`, `scroll`, `drag`, `press_key`, `type_text`, `perform_secondary_action` | Ten step-by-step tools for direct operation, used in place of `js` when `direct` is `wrapped` |

### How a delegated task runs

1. **The model operates and reports facts only.** It gets the same instructions, `js` / `js_reset` tools and results as inside ChatGPT, plus a short delegation brief. It has no other tools. Its report covers what it did, what it saw, and what is left undone. It doesn't judge.
2. **Screenshots come back as evidence.** Every screenshot a `js` call returns is numbered and saved under `$TMPDIR/magpie-computer-use/evidence/<session_id>/`, at no extra model turn. The report cites the numbers (`#3`) next to the facts they show, and the cited images come back with it (the last screenshot when none is cited).
3. **The agent decides and can follow up.** It calls again with the returned `session_id`, and the model carries on from the same screen. A session expires after 30 idle minutes. The agent can also `look` at the screen itself.

The model is called through magpie's gateway (`/v1/messages`). Its requests show as **MCU** on magpie's routing and usage pages.

The upstream API (Messages, Chat Completions or Responses) is set by the model's provider in magpie. For GPT models, give the provider a Responses address only, then restart magpie. This lets reasoning carry over between steps and prompt caching work. In our runs it was about 4× faster than Chat Completions at about ⅓ of the cost.

## Settings (Plugins › MCU)

- **Tools for the agent:**
  - *Let the agent choose* (default): the agent gets both kinds of tools.
  - *Delegate only*: every task goes to the chosen model.
  - *Direct only*: the agent operates by itself.

  After changing this, reconnect the MCP server in the agent, or start a new session.
- **Executor model** (hidden under *Direct only*):
  - the default model
  - reasoning effort
  - maximum steps
  - how many screenshots come back with each report
- **Use the Chrome extension to operate web pages**, off by default: when on, the model and the agent get ChatGPT's own browser API and work in Chrome tabs directly, instead of clicking through Chrome as an ordinary app. MCU starts LCU with `--chrome` and, when needed, runs `lcu browser install` so the ChatGPT Chrome extension connects through LCU (the ChatGPT app's own Chrome features keep working). You install and enable the [ChatGPT extension](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg) in Chrome yourself; after the first switch-on, restart Chrome or turn the extension off and on at `chrome://extensions`. The page shows the connector and extension status; **Check again** runs the check again (about 15 seconds). Each site asks for approval the first time it is used, following *App approval* below.
- **App approval:**
  - *Ask me* (default): the first time an app is used, you are asked whether to allow it once, for this session, or always.
  - *Follow the agent's permission mode*: works in Claude Code. It adds a hook for this plugin to `~/.claude/settings.json`. Bypass and auto modes allow, the default and accept-edits modes ask, and plan mode refuses.
  - *Allow every app*: never asks. It writes no lasting approval.

  The terminal, the agent's host app and magpie itself are never approved.

The same options can be set from the command line, for example `magpie plugin options magpie-computer-use '{"model":"provider/model"}'`:

| Option | Default | Meaning |
| --- | --- | --- |
| `model` | none | Model for delegated tasks (`provider/model`) |
| `tools` | `both` | `both`, `delegate` or `direct` |
| `direct` | `original` | Direct-operation tools: `original` (`js` / `js_reset`) or `wrapped` (the ten tools) |
| `executorEffort` | `medium` | `auto` (not set), `low`, `medium`, `high`, `xhigh`, `max` |
| `maxSteps` | `40` | Most model turns in one delegated task (1–200) |
| `evidenceImages` | `4` | Screenshots returned with each report (0–10). The rest are given as file paths |
| `approval` | `manual` | `manual`, `agent` or `auto`. `auto` also allows websites in browser mode |
| `chrome` | `false` | Browser mode: start LCU with `--chrome` (runs `lcu browser install` when needed) |
| `delegateVia` | `api` | `api`: MCU calls the model. `codex`: the task goes to Codex (`codex exec` with OpenAI's Computer Use plugin). `codexPath` sets the Codex binary |
| `maxTokens` | `32000` | Most output tokens per model turn, reasoning included |
| `gatewayUrl`, `gatewayKey` | local gateway | Rarely changed |

## What it reads and writes

- **magpie's config folder** (`~/.config/magpie`):
  - reads `plugins.json` (its own options), `providers.json` and `icons/` (model list for the settings page)
  - adds its own MCP server to `library.json`, and takes it out again when the plugin is removed
- **magpie's gateway** (`127.0.0.1:3425`): screenshots and the task go to the model you picked, through magpie.
- **LCU and the ChatGPT app's Computer Use runtime**: they operate the apps. App approval stays with you.
- **`$TMPDIR/magpie-computer-use/`**: evidence screenshots, kept for one day.
- **Chrome's native-messaging host** (browser mode only): `lcu browser install` points the ChatGPT extension's host at LCU's relay.
- **`~/.claude/settings.json`**: written only if you choose *Follow the agent's permission mode*, and then only this plugin's own hook entry.
- **The settings page** reads and writes nothing but the plugin's options, through `_magpie/bridge.js`. It reaches no network.

It registers no provider, asks for no sign-in and stores no credentials.

## Known limits

- macOS on Apple Silicon only. It depends on the ChatGPT app's Computer Use runtime and on LCU.
- Using the same app yourself while a task runs can push its window to the back and disturb the task.
- iPhone Mirroring works, but the phone must be locked. Swipes go through the `scroll` tool.

## Troubleshooting

```sh
MCU=~/.config/magpie/plugins/node_modules/magpie-computer-use/bin/magpie-computer-use.mjs
node $MCU doctor            # checks magpie, the gateway, the default model, LCU and the ChatGPT app
node $MCU doctor --live     # also connects to the LCU runtime once
~/.local/share/lcu/current/bin/lcu doctor   # LCU's own check
```

| Message | What to do |
| --- | --- |
| No model available | Pick a model under Plugins › MCU |
| Can't reach magpie's gateway | Make sure magpie is running |
| No usable LCU found | Install LCU, or point `MAGPIE_CU_LCU` at it |
| `Computer Use was not approved to use <app>` | Run `lcu apps allow <app>` |
| Step limit reached | Call again with the `session_id`, or raise the step limit |
| The settings page looks old | Press ⌘R in magpie's window |

## Test

```sh
npm install
npm test
node bench/run.mjs --agent provider/model    # compares delegate / original js / ten tools on real apps; see bench/REPORT.md
```

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
