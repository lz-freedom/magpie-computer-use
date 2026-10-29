import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DELEGATION_PROMPT, citedEvidence, executorToolset, formatDelegatedResult, reasoningFields, runDelegatedTask, toAnthropicContent } from '../src/agent.mjs';

const IMAGE = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' };
const INSTRUCTIONS = 'UI automation through cua_repl using the initialized cua API.';
const ORIGINAL_TOOLS = [
  { name: 'js', description: 'ORIGINAL JS', inputSchema: { type: 'object', properties: { code: { type: 'string' }, title: { type: 'string' } }, required: ['code'] } },
  { name: 'js_reset', description: 'ORIGINAL RESET', inputSchema: { type: 'object', properties: {} } },
];
const TOOLSET = executorToolset({ instructions: INSTRUCTIONS, tools: ORIGINAL_TOOLS });

// 按脚本依次返回模型回复，并记录每次请求（深拷贝，便于检查当时的上下文）。
function scriptedModel(replies) {
  const requests = [];
  const createMessage = async body => {
    requests.push(structuredClone(body));
    const reply = replies.shift();
    if (!reply) throw new Error('脚本中没有更多回复');
    return { usage: { input_tokens: 100, output_tokens: 10 }, ...reply };
  };
  return { createMessage, requests };
}

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const js = (id, code, title) => toolUse(id, 'js', title ? { code, title } : { code });
const run = (options) => runDelegatedTask({ model: 'a/b', maxSteps: 10, maxTokens: 1000, toolset: TOOLSET, ...options });

test('执行模型的工具与指令：原始指令开头加委托规则；工具只有原版 js / js_reset（与 ChatGPT 一致）', () => {
  assert.ok(TOOLSET.system.startsWith(INSTRUCTIONS));
  assert.ok(TOOLSET.system.endsWith(DELEGATION_PROMPT));
  assert.match(DELEGATION_PROMPT, /执行模型的看法/);
  assert.deepEqual(TOOLSET.tools.map(tool => tool.name), ['js', 'js_reset']);
  assert.equal(TOOLSET.tools[0].description, 'ORIGINAL JS');
  assert.deepEqual(TOOLSET.tools[0].input_schema, ORIGINAL_TOOLS[0].inputSchema);
});

test('模型调用 js、读取结果并给出报告；调用原样交给运行时', async () => {
  const { createMessage, requests } = scriptedModel([
    { stop_reason: 'tool_use', content: [{ type: 'text', text: '' }, js('t1', 'await cua.getState();')] },
    { stop_reason: 'tool_use', content: [js('t2', 'let app = await cua.getApp("Calculator");', '打开计算器')] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '计算结果是 42。' }] },
  ]);
  const executed = [];
  const execute = async (name, input) => {
    executed.push([name, input]);
    return { content: [{ type: 'text', text: 'state' }, IMAGE] };
  };
  const steps = [];
  const result = await run({ task: '算 6×7', app: 'Calculator', createMessage, execute, onStep: step => steps.push(step) });
  assert.equal(result.text, '计算结果是 42。');
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(executed, [['js', { code: 'await cua.getState();' }], ['js', { code: 'let app = await cua.getApp("Calculator");', title: '打开计算器' }]]);
  assert.deepEqual(steps.map(step => step.index), [1, 2]);
  assert.deepEqual(result.usage, { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(result.lastImage, IMAGE);

  const first = requests[0];
  assert.equal(first.model, 'a/b');
  assert.equal(first.system, TOOLSET.system);
  assert.match(first.messages[0].content, /算 6×7[\s\S]*目标应用：Calculator/);
  const second = requests[1];
  assert.deepEqual(second.messages[1].content, [js('t1', 'await cua.getState();')]);
  const toolResult = second.messages[2].content[0];
  assert.equal(toolResult.tool_use_id, 't1');
  assert.deepEqual(toolResult.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } });
  // 最后的助手报告留在 messages 中，便于继续。
  assert.equal(result.messages.at(-1).role, 'assistant');
});

test('工具结果原样转交：长文字不截断，截图不裁剪', async () => {
  const LONG = 'x'.repeat(60_000);
  const replies = Array.from({ length: 6 }, (_, index) => ({ stop_reason: 'tool_use', content: [js(`t${index}`, 'shot')] }));
  const { createMessage, requests } = scriptedModel([...replies, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
  await run({ task: 't', createMessage, execute: async () => ({ content: [{ type: 'text', text: LONG }, IMAGE] }) });
  const last = requests.at(-1).messages;
  const images = last.flatMap(message => (Array.isArray(message.content) ? message.content : []))
    .flatMap(block => (block.type === 'tool_result' ? block.content : []))
    .filter(block => block.type === 'image');
  assert.equal(images.length, 6);
  assert.equal(last[2].content[0].content[0].text.length, 60_000);
});

test('工具出错时把错误作为 is_error 结果交给模型，由模型决定下一步', async () => {
  const { createMessage, requests } = scriptedModel([
    { stop_reason: 'tool_use', content: [js('t1', 'bad')] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '没能完成。' }] },
  ]);
  const result = await run({ task: 't', createMessage, execute: async () => ({ content: [{ type: 'text', text: 'SyntaxError' }], isError: true }) });
  assert.equal(requests[1].messages[2].content[0].is_error, true);
  assert.equal(result.steps[0].isError, true);
});

test('execute 抛出的异常也转为错误结果，不会中断整个任务', async () => {
  const { createMessage, requests } = scriptedModel([
    { stop_reason: 'tool_use', content: [js('t1', 'x')] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '运行时不可用。' }] },
  ]);
  const result = await run({ task: 't', createMessage, execute: async () => { throw new Error('LCU 未连接'); } });
  assert.equal(result.text, '运行时不可用。');
  assert.match(requests[1].messages[2].content[0].content[0].text, /LCU 未连接/);
});

test('达到步数上限时停止并标记 max_steps', async () => {
  const { createMessage } = scriptedModel(Array.from({ length: 5 }, (_, index) => ({ stop_reason: 'tool_use', content: [js(`t${index}`, 'x')] })));
  const result = await run({ task: 't', maxSteps: 2, createMessage, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
  assert.equal(result.stopReason, 'max_steps');
  assert.equal(result.steps.length, 2);
  const output = formatDelegatedResult(result);
  assert.equal(output.isError, true);
  assert.match(output.content[0].text, /已达到步数上限/);
});

test('没有模型时给出设置方法', async () => {
  await assert.rejects(run({ task: 't', model: null, createMessage: async () => ({}), execute: async () => ({}) }), /magpie plugin options/);
});

test('取消信号会中止任务', async () => {
  const controller = new AbortController();
  const createMessage = async () => {
    controller.abort();
    return { stop_reason: 'tool_use', content: [js('t1', 'x')] };
  };
  await assert.rejects(run({ task: 't', createMessage, execute: async () => ({ content: [] }), signal: controller.signal }));
});

test('MCP 内容转换：图片转为 base64 块、未知类型说明、空结果占位', () => {
  assert.deepEqual(toAnthropicContent([{ type: 'audio', data: 'x' }]), [{ type: 'text', text: '[audio 内容未转发]' }]);
  assert.deepEqual(toAnthropicContent([]), [{ type: 'text', text: '(无输出)' }]);
  assert.equal(toAnthropicContent([IMAGE])[0].source.media_type, 'image/jpeg');
});

test('截图自动编号存为证据，结果末尾注明编号，不多花模型往返；报告引用的编号带上标签', async () => {
  const LATER = { type: 'image', data: 'bGF0ZXI=', mimeType: 'image/png' };
  const { createMessage, requests } = scriptedModel([
    { stop_reason: 'tool_use', content: [js('t1', 'shot A')] },
    { stop_reason: 'tool_use', content: [js('t2', 'shot B')] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '看到的事实：\n- **方案 A 首页** #3：蓝色按钮\n- 颜色 #1F2937 与 #99 不是证据' }] },
  ]);
  let shots = 0;
  const result = await run({
    task: '对比 A 和 B', createMessage, evidenceOffset: 2,
    execute: async () => ({ content: [{ type: 'text', text: 'AX' }, shots++ ? LATER : IMAGE] }),
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[1].messages.at(-1).content[0].content.at(-1).text, '[MCU] 截图已存为证据 #3，可在报告中引用。');
  assert.deepEqual(result.screenshots.map(item => [item.number, item.cited, item.label, item.image]), [[3, true, '方案 A 首页', IMAGE], [4, false, '截图 #4', LATER]]);
  assert.equal(result.lastImage, LATER);
});

test('报告引用：只认本次截图的编号，同一编号取第一次出现的说明', () => {
  const shots = [5, 6].map(number => ({ number, image: IMAGE }));
  const items = citedEvidence('1. 登录后的控制台（#5）\n计算器显示 6 × 7 = 42。#6\n#600', shots);
  assert.deepEqual(items.map(item => [item.number, item.cited, item.label]), [[5, true, '登录后的控制台'], [6, true, '计算器显示 6 × 7 = 42']]);
});

test('带上 history 时接着上一次的对话执行后续指令', async () => {
  const history = [
    { role: 'user', content: '打开 A' },
    { role: 'assistant', content: [{ type: 'text', text: '已打开 A。' }] },
  ];
  const { createMessage, requests } = scriptedModel([{ stop_reason: 'end_turn', content: [{ type: 'text', text: '已滚动。' }] }]);
  const result = await run({ task: '再往下滚', createMessage, execute: async () => ({ content: [] }), history, lastImage: IMAGE });
  assert.equal(requests[0].messages.length, 3);
  assert.match(requests[0].messages[2].content, /后续指令：\n再往下滚/);
  assert.equal(history.length, 2, '不修改传入的 history');
  assert.equal(result.messages.length, 4);
  assert.equal(result.lastImage, IMAGE, '沿用上次最后的截图');
});

test('上次停在步数上限（末尾是工具结果）时，后续指令合并进同一条用户消息', async () => {
  const history = [
    { role: 'user', content: '打开 A' },
    { role: 'assistant', content: [js('t1', 'x')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'apps' }] }] },
  ];
  const { createMessage, requests } = scriptedModel([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
  await run({ task: '继续', createMessage, execute: async () => ({ content: [] }), history });
  const last = requests[0].messages.at(-1);
  assert.equal(requests[0].messages.length, 3);
  assert.deepEqual(last.content.map(block => block.type), ['tool_result', 'text']);
});

test('有应用未授权时，报告提示用 lcu apps allow 授权', () => {
  const result = {
    model: 'a/b', text: '无法读取', stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    steps: [{ tool: 'js', input: { code: 'x' }, isError: true, summary: 'Computer Use was not approved to use Calculator' }],
  };
  assert.match(formatDelegatedResult(result).content[0].text, /lcu apps allow "Calculator"/);
});

test('报告包含模型、步骤（js 显示标题）与 token，按需附上最后一张截图', () => {
  const result = {
    model: 'a/b', text: '完成', stopReason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 }, lastImage: IMAGE,
    steps: [{ tool: 'js', input: { code: 'x', title: '打开计算器' }, isError: false, summary: 'AX' }],
  };
  const plain = formatDelegatedResult(result);
  assert.equal(plain.content.length, 1);
  assert.match(plain.content[0].text, /执行模型：a\/b；工具调用 1 次/);
  assert.match(plain.content[0].text, /1\. js 打开计算器 — AX/);
  const withImage = formatDelegatedResult(result, { includeScreenshot: true });
  assert.equal(withImage.content.at(-1), IMAGE);
});

test('证据：列出并附上报告引用的截图，其余只给目录；没有引用时给最后一张；并给出 session_id', () => {
  const result = { model: 'a/b', text: '看到的事实：…', stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, steps: [] };
  const image = data => ({ type: 'image', data, mimeType: 'image/png' });
  const evidence = [1, 2, 3, 4].map(number => ({ number, label: `画面${number}`, cited: number !== 4, image: image(String(number)), file: `/tmp/e/0${number}.png` }));
  const output = formatDelegatedResult(result, { evidence, maxImages: 2, sessionId: 's-1' });
  const [head, ...rest] = output.content;
  assert.match(head.text, /证据截图（报告引用的 3 张/);
  assert.match(head.text, /#1 画面1（未附原图，需要时用 Read 打开文件；\/tmp\/e\/01\.png）/);
  assert.match(head.text, /#3 画面3（已附在下方；\/tmp\/e\/03\.png）/);
  assert.doesNotMatch(head.text, /#4 画面4/);
  assert.match(head.text, /本次共 4 张截图，全部保存在 \/tmp\/e/);
  assert.match(head.text, /session_id：s-1/);
  assert.deepEqual(rest.filter(part => part.type === 'image').map(part => part.data), ['2', '3']);
  assert.equal(formatDelegatedResult(result, { evidence, maxImages: 0 }).content.length, 1);

  const uncited = evidence.map(item => ({ ...item, cited: false }));
  const fallback = formatDelegatedResult(result, { evidence: uncited, maxImages: 4 });
  assert.match(fallback.content[0].text, /报告没有引用截图，这是最后一张/);
  assert.match(fallback.content[0].text, /#4 最终画面（已附在下方/);
  assert.deepEqual(fallback.content.filter(part => part.type === 'image').map(part => part.data), ['4']);
});

test('推理强度经 Messages 请求交给 magpie；思考内容原样留在对话里，auto 不发送', async () => {
  assert.deepEqual(reasoningFields('auto'), {});
  assert.deepEqual(reasoningFields(undefined), {});
  const thinking = { type: 'thinking', thinking: '先截图', signature: 'sig' };
  const { createMessage, requests } = scriptedModel([
    { stop_reason: 'tool_use', content: [thinking, js('c1', 'return 1')] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] },
  ]);
  const execute = async () => ({ content: [{ type: 'text', text: '1' }] });
  await run({ task: 't', effort: 'high', createMessage, execute });
  assert.deepEqual(requests[0].thinking, { type: 'adaptive' });
  assert.deepEqual(requests[0].output_config, { effort: 'high' });
  assert.deepEqual(requests[1].messages[1].content[0], thinking);

  const plain = scriptedModel([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
  await run({ task: 't', effort: 'auto', createMessage: plain.createMessage, execute });
  assert.equal('thinking' in plain.requests[0], false);
  assert.equal('output_config' in plain.requests[0], false);
});
