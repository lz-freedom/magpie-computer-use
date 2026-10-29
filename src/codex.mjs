/**
 * 委托给 Codex：用 `codex exec` 让执行模型在 Codex 的官方 Harness 里、用官方 Computer Use 插件完成任务。
 * 与 ChatGPT / Codex 中使用 Terra 的方式完全相同（系统提示、推理设置、上下文管理与插件都由 Codex 负责），
 * MCU 只负责启动进程、读取事件、把最终报告交回调用方 Agent；续接用 `codex exec resume <thread_id>`。
 * Codex 自己的配置里若也登记了 MCU，会在这次运行中关掉，避免执行模型再调回 MCU。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ChatGPT 应用自带的 Codex（带官方插件）；没有时用 PATH 中的 codex。
export const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
export const CODEX_WORKDIR = path.join(os.tmpdir(), 'magpie-computer-use', 'codex');

export function codexCommand(configured) {
  if (configured) return configured;
  return fs.existsSync(BUNDLED_CODEX) ? BUNDLED_CODEX : 'codex';
}

/** 交给 Codex 的任务说明：委托规则与汇报格式（截图证据由 Codex 自己查看，报告里描述）。 */
export function codexPrompt(instruction, { followUp = false } = {}) {
  if (followUp) return `委托方 Agent 的后续指令：\n${instruction}`;
  return `你在替另一个 AI Agent（委托方）操作这台 Mac 上的应用，用 Computer Use 完成下面的任务。你是它的手和眼，判断由它来做。没有人会中途回答问题。

规则：
- 只做任务要求的事。除非任务明确要求，不要发送消息、提交表单、删除数据、购买或修改设置。
- 应用未授权或无法继续时，停下来说明需要什么。
- 同一个操作试几次都不成功，就停下来如实报告；不要用开发者工具、页面脚本或打开其他应用来绕过。

最后的报告（用用户的语言），只陈述事实：
- 做了什么：简要列出操作。
- 看到的事实：屏幕上的内容与任务要找的信息（文字、数值、名称、位置、颜色）。
- 未完成：没做完的部分和原因。
不要评价好坏、不要替委托方下结论；任务明确问你的看法时，才在最后单列“执行模型的看法”。

任务：
${instruction}`;
}

/** 解析 `codex exec --json` 的一行事件。 */
export function parseCodexEvent(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * 运行一次 Codex 委托。返回 { threadId, text, steps, usage, stopReason, error }。
 * onStep 在每个工具调用完成时调用；signal 取消时结束 Codex 进程。
 */
export function runCodexTask({
  command, model, effort, prompt, threadId = null, signal, onStep = () => {}, spawnProcess = spawn, workdir = CODEX_WORKDIR,
}) {
  fs.mkdirSync(workdir, { recursive: true });
  const config = [
    '-c', 'mcp_servers.magpie-computer-use.enabled=false',
    ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
  ];
  const common = ['--json', '--skip-git-repo-check', ...(model ? ['-m', model] : []), ...config];
  const args = threadId ? ['exec', 'resume', threadId, ...common, prompt] : ['exec', ...common, '-C', workdir, prompt];
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = { threadId, text: '', steps: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 }, stopReason: 'end_turn', error: null };
    let buffer = '';
    let stderr = '';
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const event = parseCodexEvent(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (event) handle(event);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`无法启动 Codex（${command}）：${error.message}`));
    });
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(signal.reason ?? new Error('已取消'));
      if (code !== 0 && !result.text) result.error = `Codex 退出码 ${code}：${stderr.trim().split('\n').slice(-3).join(' ')}`;
      resolve(result);
    });

    function handle(event) {
      if (event.type === 'thread.started' && event.thread_id) result.threadId = event.thread_id;
      if (event.type === 'turn.completed' && event.usage) {
        const usage = event.usage;
        const cached = usage.cached_input_tokens ?? 0;
        result.usage.input_tokens += (usage.input_tokens ?? 0) - cached;
        result.usage.cache_read_input_tokens += cached;
        result.usage.output_tokens += usage.output_tokens ?? 0;
        result.usage.reasoning_tokens += usage.reasoning_output_tokens ?? 0;
      }
      if (event.type === 'turn.failed') result.error = event.error?.message ?? 'Codex 执行失败';
      const item = event.item;
      if (event.type !== 'item.completed' || !item) return;
      if (item.type === 'agent_message' && item.text) result.text = item.text;
      if (item.type === 'mcp_tool_call' || item.type === 'command_execution' || item.type === 'function_call') {
        const failed = item.status === 'failed' || Boolean(item.error);
        const name = item.tool ? `${item.server ? `${item.server}.` : ''}${item.tool}` : item.type;
        const step = { tool: name, input: item.arguments ?? {}, isError: failed, summary: summarizeItem(item) };
        result.steps.push(step);
        void onStep({ ...step, index: result.steps.length });
      }
    }
  });
}

function summarizeItem(item) {
  const content = item.result?.content ?? [];
  const text = content.find(part => part?.type === 'text')?.text ?? item.aggregated_output ?? item.error?.message ?? '';
  const images = content.filter(part => part?.type === 'image').length;
  const head = String(text).replace(/\s+/g, ' ').slice(0, 120);
  return `${head}${String(text).length > 120 ? '…' : ''}${images ? ` [截图×${images}]` : ''}`;
}
