#!/usr/bin/env node
/**
 * 三种方式的对比评测。模拟一个 Agent（默认 Claude Opus 5.5，经 magpie 网关）连接 MCU，完成同样的任务：
 * - delegate：Agent → computer_use → 执行模型（默认 GPT-6.1 Terra）→ 原版 js / js_reset
 * - original：Agent 直接用原版 js / js_reset
 * - wrapped：Agent 直接用插件包装的十个工具
 *
 * 用法：node bench/run.mjs [--suite desktop|iphone|extra] [--tasks t01,t02] [--modes delegate,original,wrapped] [--agent provider/model] [--executor provider/model]
 * 结果写入 bench/results/<时间>/：results.jsonl（每次运行一行）与 report.md。会实际操作本机应用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGatewayClient } from '../src/gateway.mjs';
import { readPluginOptions } from '../src/options.mjs';
import { createComputerUseServer, openLcuRuntime } from '../src/server.mjs';
import { EXTRA_TASKS, IPHONE_TASKS, TASKS as DESKTOP_TASKS, answerOf, prepareRoot, startFixtureServer } from './tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const MODES = argument('--modes', 'delegate,original,wrapped').split(',');
const SUITE = argument('--suite', 'desktop');
const IPHONE = SUITE === 'iphone' || SUITE === 'extra';
const TASKS = { iphone: IPHONE_TASKS, extra: EXTRA_TASKS }[SUITE] ?? DESKTOP_TASKS;
const TASK_IDS = argument('--tasks', TASKS.map(task => task.id).join(',')).split(',');
// 模拟的 Agent 与执行模型：用 magpie 中的 provider/model。执行模型默认取插件设置里的模型。
const AGENT_MODEL = argument('--agent', process.env.MCU_BENCH_AGENT);
const EXECUTOR_MODEL = argument('--executor', process.env.MCU_BENCH_EXECUTOR ?? (await readPluginOptions()).model);
if (!AGENT_MODEL || !EXECUTOR_MODEL) {
  console.error('请用 --agent provider/model 指定模拟的 Agent 模型（也可设 MCU_BENCH_AGENT）；执行模型取插件设置，或用 --executor 指定。');
  process.exit(2);
}
const AGENT_MAX_TURNS = Number(argument('--max-turns', SUITE === 'extra' ? '150' : '60'));
const TASK_TIMEOUT_MS = Number(argument('--timeout', String((SUITE === 'extra' ? 30 : 15) * 60_000)));

const EXECUTOR_EFFORT = argument('--effort', 'medium');
// --chrome：以 lcu --chrome 启动运行时，执行模型与 Agent 可用 ChatGPT 原版的浏览器 API。
const CHROME = process.argv.includes('--chrome');

const MODE_OPTIONS = {
  // 委托：执行模型经 magpie 的 /v1/messages，上游接口由供应商设置决定。
  delegate: { tools: 'delegate', direct: 'wrapped' },
  // Codex：执行模型在 Codex 的官方 Harness 里用官方 Computer Use 插件执行。
  'delegate-codex': { tools: 'delegate', direct: 'wrapped', delegateVia: 'codex' },
  original: { tools: 'direct', direct: 'original' },
  wrapped: { tools: 'direct', direct: 'wrapped' },
};

const AGENT_SYSTEM = instructions => `You are an AI agent working on the user's Mac. You can operate desktop apps only through the tools of the MCP server "magpie-computer-use".

MCP server instructions:
${instructions}

Do the task yourself with these tools; do not ask the user questions. When you are done, end your reply with one final line in exactly this format:
答案：<the answer>`;

// MCP 结果 → Anthropic tool_result 内容。
function toBlocks(content = []) {
  const blocks = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
    else if (part.type === 'image' && part.data) blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mimeType || 'image/png', data: part.data } });
  }
  return blocks.length ? blocks : [{ type: 'text', text: '(no output)' }];
}

// 提示缓存：工具定义与最近一条用户消息打上缓存断点，与 Claude Code 的做法相近。
function withCache(messages) {
  const copy = messages.map(message => ({ ...message }));
  for (let index = copy.length - 1, marked = 0; index >= 0 && marked < 2; index--) {
    const message = copy[index];
    if (message.role !== 'user') continue;
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content.map(block => ({ ...block }));
    blocks[blocks.length - 1] = { ...blocks.at(-1), cache_control: { type: 'ephemeral' } };
    copy[index] = { ...message, content: blocks };
    marked += 1;
  }
  return copy;
}

const emptyUsage = () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, requests: 0 });
const addUsage = (total, usage = {}) => {
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) total[key] += usage[key] ?? 0;
  total.requests += 1;
};

async function runOne(task, mode, { pricing, directory, fixtures, home }) {
  const state = {};
  await task.prepare?.(state, { server: fixtures });
  const expected = task.expected(state);
  const base = await readPluginOptions();
  const options = { ...base, ...MODE_OPTIONS[mode], model: EXECUTOR_MODEL, executorEffort: EXECUTOR_EFFORT, chrome: CHROME, approval: 'auto', maxSteps: SUITE === 'extra' ? 150 : 60, evidenceImages: 4 };
  const executorUsage = emptyUsage();
  // 执行模型的请求经这里，按任务累计用量。
  const createGateway = config => {
    const gateway = createGatewayClient(config);
    return { ...gateway, url: gateway.url, listModels: gateway.listModels, createMessage: async (body, request) => {
      const response = await gateway.createMessage(body, request);
      addUsage(executorUsage, response.usage);
      return response;
    } };
  };
  const { server, close } = createComputerUseServer({ loadOptions: async () => options, createGateway, direct: options.direct });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcu-bench-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  const agentGateway = createGatewayClient({ url: options.gatewayUrl, key: options.gatewayKey, timeoutMs: 600_000 });
  const agentUsage = emptyUsage();
  const toolCalls = {};
  let executorToolCalls = 0;
  let finalText = '';
  let error = null;
  // 最后一张截图（直接操作时为 Agent 看到的最后一张，委托时为最后一张证据），供人工核对。
  let lastImage = null;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS);
  try {
    const { tools } = await client.listTools();
    const anthropicTools = tools.map((tool, index) => ({
      name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema,
      ...(index === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
    const system = AGENT_SYSTEM(client.getInstructions() ?? '');
    const messages = [{ role: 'user', content: task.prompt(state) }];
    for (let turn = 0; turn < AGENT_MAX_TURNS; turn++) {
      const response = await agentGateway.createMessage({
        model: AGENT_MODEL, max_tokens: 8192, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: anthropicTools, messages: withCache(messages),
      }, { signal: controller.signal });
      addUsage(agentUsage, response.usage);
      const content = (response.content ?? []).filter(block => block.type !== 'text' || block.text);
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
      if (text) finalText = text;
      const calls = content.filter(block => block.type === 'tool_use');
      messages.push({ role: 'assistant', content });
      if (!calls.length) break;
      const results = [];
      for (const call of calls) {
        toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1;
        let result;
        try {
          result = await client.callTool({ name: call.name, arguments: call.input ?? {} }, undefined, { signal: controller.signal, timeout: TASK_TIMEOUT_MS });
        } catch (failure) {
          result = { content: [{ type: 'text', text: String(failure.message ?? failure) }], isError: true };
        }
        const image = [...(result.content ?? [])].reverse().find(part => part.type === 'image' && part.data);
        if (image) lastImage = image;
        if (call.name === 'computer_use') {
          const report = result.content?.[0]?.text ?? '';
          executorToolCalls += Number(/工具调用 (\d+) 次/.exec(report)?.[1] ?? 0);
          // Codex 方式的执行模型请求不经过这里的网关客户端，用量从报告里读。
          if (mode === 'delegate-codex') {
            const match = /tokens 输入 (\d+) \/ 输出 (\d+)(?: \/ 缓存读取 (\d+))?/.exec(report);
            if (match) addUsage(executorUsage, { input_tokens: Number(match[1]), output_tokens: Number(match[2]), cache_read_input_tokens: Number(match[3] ?? 0) });
          }
        }
        results.push({ type: 'tool_result', tool_use_id: call.id, content: toBlocks(result.content), ...(result.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (failure) {
    error = controller.signal.aborted ? `超时（${TASK_TIMEOUT_MS / 60_000} 分钟）` : String(failure.message ?? failure);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
    await close().catch(() => {});
  }
  const seconds = (Date.now() - started) / 1000;
  let screenshot = null;
  if (lastImage) {
    screenshot = `${task.id}-${mode}.${lastImage.mimeType?.includes('png') ? 'png' : 'jpg'}`;
    await fs.writeFile(path.join(directory, screenshot), Buffer.from(lastImage.data, 'base64'));
  }
  const answer = answerOf(finalText);
  let passed = false;
  if (!error) {
    try { passed = Boolean(await task.grade(answer, expected, state)); } catch { passed = false; }
  }
  await task.cleanup?.(state, { home });
  const cost = usageCost(agentUsage, pricing[AGENT_MODEL]) + usageCost(executorUsage, pricing[EXECUTOR_MODEL]);
  return {
    task: task.id, level: task.level, title: task.title, mode, passed, manual: Boolean(task.manual), expected, answer, error, seconds, screenshot,
    agentTurns: agentUsage.requests, agentToolCalls: Object.values(toolCalls).reduce((a, b) => a + b, 0), toolCalls,
    executorTurns: executorUsage.requests, executorToolCalls,
    agentUsage, executorUsage, cost, finalText,
  };
}

function usageCost(usage, price) {
  if (!price) return 0;
  const number = key => Number(price[key] ?? 0);
  return usage.input_tokens * number('prompt') + usage.output_tokens * number('completion')
    + usage.cache_read_input_tokens * number('input_cache_read') + usage.cache_creation_input_tokens * number('input_cache_write');
}

const MODE_LABEL = { 'delegate-codex': 'Agent → Codex（Terra）→ 官方插件', delegate: 'Agent → 执行模型 → 原版 js', original: 'Agent → 原版 js', wrapped: 'Agent → 十个工具' };
const k = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

function report(rows) {
  const lines = [`# MCU 三种方式对比`, '', `- Agent：${AGENT_MODEL}；执行模型：${EXECUTOR_MODEL}${CHROME ? '；浏览器 API：开启' : ''}`, `- 时间：${new Date().toLocaleString('zh-CN')}`, ''];
  lines.push('## 汇总', '', '| 方式 | 成功 | 总耗时 | 平均耗时 | Agent 轮数 | Agent 输入 token（含缓存） | 执行模型 token | 估算费用 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const mode of MODES) {
    const list = rows.filter(row => row.mode === mode);
    if (!list.length) continue;
    const sum = fn => list.reduce((total, row) => total + fn(row), 0);
    const agentIn = sum(row => row.agentUsage.input_tokens + row.agentUsage.cache_read_input_tokens + row.agentUsage.cache_creation_input_tokens);
    const execIn = sum(row => row.executorUsage.input_tokens + row.executorUsage.cache_read_input_tokens + row.executorUsage.cache_creation_input_tokens + row.executorUsage.output_tokens);
    lines.push(`| ${MODE_LABEL[mode]} | ${sum(row => (row.passed ? 1 : 0))}/${list.length} | ${Math.round(sum(row => row.seconds))} 秒 | ${Math.round(sum(row => row.seconds) / list.length)} 秒 | ${sum(row => row.agentTurns)} | ${k(agentIn)} | ${k(execIn)} | $${sum(row => row.cost).toFixed(2)} |`);
  }
  lines.push('', '## 每个任务', '', `| 任务 | 难度 | ${MODES.map(mode => MODE_LABEL[mode]).join(' | ')} |`, `| --- | --- | ${MODES.map(() => '---').join(' | ')} |`);
  for (const task of TASKS.filter(item => TASK_IDS.includes(item.id))) {
    const cells = MODES.map(mode => {
      const row = rows.find(item => item.task === task.id && item.mode === mode);
      if (!row) return '—';
      const steps = mode.startsWith('delegate') ? `${row.executorToolCalls} 步` : `${row.agentToolCalls} 步`;
      return `${row.passed ? (row.manual ? '🔎' : '✅') : '❌'} ${Math.round(row.seconds)} 秒 · ${steps} · $${row.cost.toFixed(2)}`;
    });
    lines.push(`| ${task.id} ${task.title} | ${task.level} | ${cells.join(' | ')} |`);
  }
  const manual = rows.filter(row => row.manual);
  if (manual.length) {
    lines.push('', '## 需人工核对的回答', '');
    for (const row of manual) lines.push(`- ${row.task} · ${MODE_LABEL[row.mode]}：${row.answer || '（无）'}${row.screenshot ? `（截图 ${row.screenshot}）` : ''}${row.error ? `；错误：${row.error}` : ''}`);
  }
  const failures = rows.filter(row => !row.passed);
  if (failures.length) {
    lines.push('', '## 失败明细', '');
    for (const row of failures) lines.push(`- ${row.task} · ${MODE_LABEL[row.mode]}：期望“${row.expected}”，回答“${row.answer || '（无）'}”${row.error ? `；错误：${row.error}` : ''}`);
  }
  lines.push('', '🔎 为格式合格、需人工核对内容的回答。步数：委托方式为执行模型的工具调用次数，直接方式为 Agent 的工具调用次数。费用按 magpie 网关的模型价格估算（含提示缓存）。');
  return `${lines.join('\n')}\n`;
}

/** 评测自己的运行时连接：任务之间给 iPhone 镜像发 ⌘1 回到主屏幕。 */
async function iphoneHome() {
  const { client } = await openLcuRuntime({ onElicitation: async () => ({ action: 'accept', content: {}, _meta: { persist: 'session' } }) });
  const identity = { sessionId: `bench-home-${Date.now()}`, turnId: `turn-${Date.now()}` };
  await client.call('js', { code: 'await cua.getState({ emit: false });', title: 'init' }, identity);
  const home = async () => {
    // 刚结束的任务连接还在收尾时，按键可能被忽略：先等一会儿，并按两次。
    await new Promise(resolve => setTimeout(resolve, 2000));
    await client.call('js', { code: 'var benchPhone = await cua.getApp("iPhone Mirroring", { emit: false });\nawait benchPhone.pressKey("super+1");', title: '回到主屏幕' }, identity).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await client.call('js', { code: 'var benchPhone = await cua.getApp("iPhone Mirroring", { emit: false });\nawait benchPhone.pressKey("super+1");', title: '回到主屏幕' }, identity)
      .catch(error => ({ isError: true, content: [{ type: 'text', text: String(error.message ?? error) }] }));
    if (result.isError) console.error(`回到主屏幕失败：${result.content.map(part => part.text).join(' ').slice(0, 300)}`);
  };
  home.close = async () => {
    await client.turnEnded(identity).catch(() => {});
    await client.close().catch(() => {});
  };
  return home;
}

async function main() {
  await prepareRoot();
  const models = await createGatewayClient({ url: 'http://127.0.0.1:3425', key: 'magpie' }).listModels();
  const pricing = Object.fromEntries(models.map(model => [model.id, model.pricing]));
  const directory = path.join(HERE, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(directory, { recursive: true });
  const rows = [];
  const server = SUITE === 'iphone' ? await startFixtureServer() : null;
  const home = IPHONE ? await iphoneHome() : null;
  const wanted = TASKS.filter(item => TASK_IDS.includes(item.id));
  // 缺少必要配置（例如登录任务的地址与账号）的任务跳过。
  for (const task of wanted.filter(item => item.skip)) console.log(`跳过 ${task.id}：${task.skip}`);
  const selected = wanted.filter(item => !item.skip);
  for (const [position, task] of selected.entries()) {
    // 三种方式的先后顺序按任务轮换，避免同一种方式总是先跑或后跑。
    const order = MODES.map((_, index) => MODES[(index + position) % MODES.length]);
    for (const mode of order) {
      process.stdout.write(`${task.id} ${mode} … `);
      const row = await runOne(task, mode, { pricing, directory, fixtures: server, home });
      rows.push(row);
      await fs.appendFile(path.join(directory, 'results.jsonl'), `${JSON.stringify(row)}\n`);
      await fs.writeFile(path.join(directory, 'report.md'), report(rows));
      console.log(`${row.passed ? '通过' : '失败'} ${row.seconds.toFixed(0)}s $${row.cost.toFixed(3)}${row.error ? ` (${row.error})` : ''}`);
    }
  }
  await server?.close();
  await home?.close();
  console.log(`\n报告：${path.join(directory, 'report.md')}`);
}

await main();
