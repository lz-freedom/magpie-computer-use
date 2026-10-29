import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { codexPrompt, runCodexTask } from '../src/codex.mjs';

// 假的 Codex 进程：按给定事件逐行输出 JSONL，然后以 code 退出。
function fakeSpawn(events, { code = 0 } = {}) {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
      child.stdout.end();
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return { spawnProcess, calls };
}

test('Codex 委托：读出线程、工具调用、最终回复与用量；关掉 Codex 里的 MCU', async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcu-codex-'));
  try {
    const { spawnProcess, calls } = fakeSpawn([
      { type: 'thread.started', thread_id: 'th-1' },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'cua_repl', tool: 'js', status: 'completed', arguments: { code: 'x' }, result: { content: [{ type: 'text', text: 'ok' }, { type: 'image' }] } } },
      { type: 'item.completed', item: { type: 'agent_message', text: '看到的事实：…\n答案：408' } },
      { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 30 } },
    ]);
    const steps = [];
    const run = await runCodexTask({ command: 'codex', model: 'a/gpt', effort: 'medium', prompt: 'p', spawnProcess, workdir, onStep: step => steps.push(step) });
    assert.equal(run.threadId, 'th-1');
    assert.match(run.text, /答案：408/);
    assert.deepEqual(run.usage, { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, reasoning_tokens: 30 });
    assert.equal(steps[0].tool, 'cua_repl.js');
    assert.match(steps[0].summary, /截图×1/);
    const args = calls[0].args;
    assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
    assert.ok(args.includes('mcp_servers.magpie-computer-use.enabled=false'));
    assert.ok(args.includes('model_reasoning_effort="medium"'));

    const resume = fakeSpawn([{ type: 'item.completed', item: { type: 'agent_message', text: '继续了' } }]);
    await runCodexTask({ command: 'codex', model: 'a/gpt', prompt: 'p2', threadId: 'th-1', spawnProcess: resume.spawnProcess, workdir });
    assert.deepEqual(resume.calls[0].args.slice(0, 3), ['exec', 'resume', 'th-1']);
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
});

test('Codex 委托：进程失败且没有回复时给出退出码', async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcu-codex-'));
  try {
    const { spawnProcess } = fakeSpawn([], { code: 2 });
    const run = await runCodexTask({ command: 'codex', prompt: 'p', spawnProcess, workdir });
    assert.match(run.error, /退出码 2/);
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
});

test('Codex 任务说明包含委托规则；后续指令只带指令本身', () => {
  assert.match(codexPrompt('算 1+1'), /不要用开发者工具[\s\S]*任务：\n算 1\+1/);
  assert.equal(codexPrompt('再滚', { followUp: true }), '委托方 Agent 的后续指令：\n再滚');
});
