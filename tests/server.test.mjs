import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { normalizeOptions } from '../src/options.mjs';
import { blockedApproval, createComputerUseServer, exposedTools, hostIdentity, openLcuRuntime } from '../src/server.mjs';

// 假运行时：记录每次 js 调用，并可通过 respond 自定义结果；onElicitation 由服务端在打开时注入。
function fakeRuntime(respond = async (_name, args) => ({ content: [{ type: 'text', text: `ran:${args.title}` }] })) {
  const calls = [];
  const ended = [];
  const state = { closed: false, onElicitation: undefined, opened: 0 };
  const runtime = {
    info: { version: '0.13.2' },
    client: {
      async call(name, args, options) {
        calls.push({ name, args, options });
        return respond(name, args, options, state);
      },
      async turnEnded(identity) { ended.push(identity); },
      async close() { state.closed = true; },
      instructions: 'UI automation through cua_repl using the initialized cua API.',
      publicTools: () => [
        { name: 'js', description: 'ORIGINAL JS DESCRIPTION', inputSchema: { type: 'object', properties: { code: { type: 'string' }, title: { type: 'string' } }, required: ['code'] } },
        { name: 'js_reset', description: 'ORIGINAL RESET', inputSchema: { type: 'object', properties: {} } },
      ],
    },
  };
  const open = async ({ onElicitation }) => {
    state.onElicitation = onElicitation;
    state.opened += 1;
    return runtime;
  };
  return { open, calls, ended, state };
}

// 通过内存传输连接服务端与一个模拟的 Agent 客户端。elicitation=false 表示 Agent 不支持授权询问。
async function connectAgent(open, {
  elicitation = true, onElicit = async () => ({ action: 'accept', content: {} }),
  options = {}, createGateway = () => { throw new Error('测试未提供网关'); }, modeOf = async () => null,
} = {}) {
  // 测试显式注入选项与权限模式，不读取本机 magpie 的 plugins.json 或钩子记录。
  // 多数用例测试十个包装工具，未指定 direct 时按 wrapped。
  const settings = { direct: 'wrapped', ...options };
  const loadOptions = async () => normalizeOptions(settings, {});
  const { server, close } = createComputerUseServer({ open, loadOptions, createGateway, modeOf, direct: settings.direct });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const agent = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: elicitation ? { elicitation: {} } : {} });
  let elicitRequests = 0;
  // 未声明 elicitation 能力的客户端不能注册该请求处理器（SDK 会拒绝），因此只在支持时注册。
  if (elicitation) {
    agent.setRequestHandler(ElicitRequestSchema, async request => {
      elicitRequests += 1;
      return onElicit(request.params);
    });
  }
  await agent.connect(clientTransport);
  return { agent, close, server, elicitRequests: () => elicitRequests };
}

const text = result => result.content.map(part => part.text ?? `[${part.type}]`).join('\n');

test('tools/list 按 tools 选项暴露工具：默认 both 为 13 个', async () => {
  const { open } = fakeRuntime();
  for (const [mode, count, sample] of [[undefined, 13, 'computer_use'], ['direct', 10, 'get_app_state'], ['delegate', 3, 'look']]) {
    const { agent, close } = await connectAgent(open, { options: mode ? { tools: mode } : {} });
    try {
      const { tools } = await agent.listTools();
      assert.equal(tools.length, count, String(mode));
      assert.ok(tools.some(tool => tool.name === sample), String(mode));
    } finally {
      await close();
    }
  }
  assert.equal(exposedTools('delegate').some(tool => tool.name === 'click'), false);
});

test('未开放的工具调用返回错误，而不是悄悄执行', async () => {
  const runtime = fakeRuntime();
  const { agent, close } = await connectAgent(runtime.open, { options: { tools: 'delegate' } });
  try {
    const result = await agent.callTool({ name: 'list_apps', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(text(result), /tools=delegate/);
    assert.equal(runtime.calls.length, 0);
  } finally {
    await close();
  }
});

test('list_apps 通过 js 调用 cua.getState()，并原样返回运行时内容', async () => {
  const runtime = fakeRuntime();
  const { agent, close } = await connectAgent(runtime.open);
  try {
    const result = await agent.callTool({ name: 'list_apps', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(text(result), 'ran:列出应用');
    assert.equal(runtime.calls.length, 1);
    assert.equal(runtime.calls[0].name, 'js');
    assert.equal(runtime.calls[0].args.code, 'await cua.getState();');
    assert.equal(typeof runtime.calls[0].options.sessionId, 'string');
    assert.equal(typeof runtime.calls[0].options.turnId, 'string');
  } finally {
    await close();
  }
});

test('get_app_state 依次执行选择与截图两次 js 调用，并合并结果', async () => {
  const runtime = fakeRuntime();
  const { agent, close } = await connectAgent(runtime.open);
  try {
    const result = await agent.callTool({ name: 'get_app_state', arguments: { app: 'Calculator' } });
    assert.equal(runtime.calls.length, 2);
    assert.equal(text(result), 'ran:get_app_state\nran:get_app_state');
  } finally {
    await close();
  }
});

test('运行时返回的错误保持 isError，并停止后续步骤', async () => {
  const runtime = fakeRuntime(async () => ({ content: [{ type: 'text', text: 'Computer Use was not approved to use Calculator' }], isError: true }));
  const { agent, close } = await connectAgent(runtime.open);
  try {
    const result = await agent.callTool({ name: 'get_app_state', arguments: { app: 'Calculator' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /not approved/);
    assert.equal(runtime.calls.length, 1);
  } finally {
    await close();
  }
});

test('参数错误作为工具错误返回，不会启动运行时', async () => {
  const runtime = fakeRuntime();
  const { agent, close } = await connectAgent(runtime.open);
  try {
    const result = await agent.callTool({ name: 'click', arguments: { app: 'TextEdit' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /requires element_index or both x and y/);
    assert.equal(runtime.state.opened, 0);
    assert.equal(runtime.calls.length, 0);
  } finally {
    await close();
  }
});

test('运行时的授权请求转交给 Agent，并把 Agent 的回答返回运行时', async () => {
  const runtime = fakeRuntime(async (_name, _args, _options, state) => {
    const answer = await state.onElicitation({ message: '允许 Calculator？', requestedSchema: { type: 'object', properties: {} } }, { signal: new AbortController().signal });
    return { content: [{ type: 'text', text: `answer:${answer.action}` }] };
  });
  const { agent, close, elicitRequests } = await connectAgent(runtime.open, { onElicit: async () => ({ action: 'decline', content: {} }) });
  try {
    const result = await agent.callTool({ name: 'list_apps', arguments: {} });
    assert.equal(text(result), 'answer:decline');
    assert.equal(elicitRequests(), 1);
  } finally {
    await close();
  }
});

test('Agent 不支持授权询问时取消，而不是挂起', async () => {
  const runtime = fakeRuntime(async (_name, _args, _options, state) => {
    const answer = await state.onElicitation({ message: '允许 Calculator？', requestedSchema: { type: 'object', properties: {} } }, { signal: new AbortController().signal });
    return { content: [{ type: 'text', text: `answer:${answer.action}` }] };
  });
  const { agent, close, elicitRequests } = await connectAgent(runtime.open, { elicitation: false });
  try {
    const result = await agent.callTool({ name: 'list_apps', arguments: {} });
    assert.equal(text(result), 'answer:cancel');
    assert.equal(elicitRequests(), 0);
  } finally {
    await close();
  }
});

test('针对宿主应用本身的授权请求直接拒绝，不交给用户', async () => {
  const runtime = fakeRuntime(async (_name, _args, _options, state) => {
    const answer = await state.onElicitation({
      message: '允许 magpie？', requestedSchema: { type: 'object', properties: {} },
      _meta: { connector_id: 'computer-use', tool_params: { app: 'com.yetone.magpie' } },
    }, { signal: new AbortController().signal });
    return { content: [{ type: 'text', text: `answer:${answer.action}` }] };
  });
  const { agent, close, elicitRequests } = await connectAgent(runtime.open);
  try {
    const result = await agent.callTool({ name: 'list_apps', arguments: {} });
    assert.equal(text(result), 'answer:decline');
    assert.equal(elicitRequests(), 0);
  } finally {
    await close();
  }
});

test('宿主提供真实的会话与轮次元数据时沿用之，并在连接关闭时结束该轮次', async () => {
  const runtime = fakeRuntime();
  const { agent, close } = await connectAgent(runtime.open);
  const meta = { 'x-codex-turn-metadata': JSON.stringify({ session_id: 'host-session', turn_id: 'host-turn' }) };
  await agent.callTool({ name: 'list_apps', arguments: {}, _meta: meta });
  assert.equal(runtime.calls[0].options.sessionId, 'host-session');
  assert.equal(runtime.calls[0].options.turnId, 'host-turn');
  assert.equal(runtime.calls[0].options.metadata['x-codex-turn-metadata'], meta['x-codex-turn-metadata']);
  await close();
  assert.deepEqual(runtime.ended, [{ sessionId: 'host-session', turnId: 'host-turn', event: 'Stop' }]);
  assert.equal(runtime.state.closed, true);
});

test('没有宿主元数据时，连接关闭只结束本连接用过的上下文', async () => {
  const runtime = fakeRuntime();
  const { agent, close } = await connectAgent(runtime.open);
  await agent.callTool({ name: 'list_apps', arguments: {} });
  await close();
  assert.equal(runtime.ended.length, 1);
  assert.equal(runtime.ended[0].sessionId, runtime.calls[0].options.sessionId);
  assert.equal(runtime.ended[0].turnId, runtime.calls[0].options.turnId);
});

test('从未调用运行时的连接关闭时不做任何清理', async () => {
  const runtime = fakeRuntime();
  const { agent, close } = await connectAgent(runtime.open);
  await agent.listTools();
  await close();
  assert.equal(runtime.ended.length, 0);
  assert.equal(runtime.state.opened, 0);
});

test('LCU 不可用时返回可读的工具错误，并在下一次调用时重新发现', async () => {
  let attempts = 0;
  const runtime = fakeRuntime();
  const open = async options => {
    attempts += 1;
    if (attempts === 1) throw new Error('找不到可用的 LCU。');
    return runtime.open(options);
  };
  const { agent, close } = await connectAgent(open);
  try {
    const first = await agent.callTool({ name: 'list_apps', arguments: {} });
    assert.equal(first.isError, true);
    assert.match(text(first), /找不到可用的 LCU/);
    const second = await agent.callTool({ name: 'list_apps', arguments: {} });
    assert.equal(second.isError, undefined);
    assert.equal(attempts, 2);
  } finally {
    await close();
  }
});

test('共享客户端接口缺失时在连接前给出明确错误', async () => {
  const discover = async () => ({ version: '0.14.0', launcher: '/fake/bin/lcu' });
  const loadClient = async () => () => ({ connect: async () => {}, call: async () => {} });
  await assert.rejects(openLcuRuntime({ discover, loadClient }), /LCU 0\.14\.0 的共享客户端缺少 turnEnded、close/);
});

test('connect 失败时关闭客户端并把错误交给调用方', async () => {
  let closed = false;
  const discover = async () => ({ version: '0.13.2', launcher: '/fake/bin/lcu' });
  const loadClient = async () => () => ({
    connect: async () => { throw new Error('Original CUA js/js_reset tools are missing'); },
    call: async () => {}, turnEnded: async () => {}, close: async () => { closed = true; },
  });
  await assert.rejects(openLcuRuntime({ discover, loadClient }), /tools are missing/);
  assert.equal(closed, true);
});

test('hostIdentity 只接受同时含会话与轮次的有效元数据', () => {
  assert.deepEqual(hostIdentity({ 'x-codex-turn-metadata': { session_id: 's', turn_id: 't' } }), { sessionId: 's', turnId: 't' });
  assert.deepEqual(hostIdentity({ 'x-codex-turn-metadata': '{"session_id":"s","turn_id":"t"}' }), { sessionId: 's', turnId: 't' });
  assert.equal(hostIdentity({ 'x-codex-turn-metadata': 'not json' }), undefined);
  assert.equal(hostIdentity({ 'x-codex-turn-metadata': { session_id: 's' } }), undefined);
  assert.equal(hostIdentity(undefined), undefined);
});

test('blockedApproval 只针对 computer-use 请求中的宿主应用', () => {
  assert.equal(blockedApproval({ _meta: { connector_id: 'computer-use', tool_params: { app: 'com.yetone.magpie' } } }), true);
  assert.equal(blockedApproval({ _meta: { connector_id: 'computer-use', tool_params: { app: 'com.apple.TextEdit' } } }), false);
  assert.equal(blockedApproval({ _meta: { connector_id: 'other', tool_params: { app: 'com.yetone.magpie' } } }), false);
});

// 假网关：listModels 返回给定模型清单，createMessage 按脚本依次回复并记录请求。
function fakeGateway({ models = [], replies = [] } = {}) {
  const requests = [];
  const created = [];
  const createGateway = config => {
    created.push(config);
    return {
      url: config.url,
      listModels: async () => models,
      createMessage: async body => {
        requests.push(structuredClone(body));
        const reply = replies.shift();
        if (!reply) throw new Error('脚本中没有更多回复');
        return { usage: { input_tokens: 1, output_tokens: 1 }, ...reply };
      },
    };
  };
  return { createGateway, requests, created };
}

const VISION = { modalities: { input: ['text', 'image'] }, tool_call: true };

test('computer_use 使用插件选项中的模型执行任务，只返回报告', async () => {
  const runtime = fakeRuntime();
  const gateway = fakeGateway({
    models: [{ id: 'relay-anthropic/claude-sonnet-5-5', ...VISION }],
    replies: [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'js', input: { code: 'await cua.getState();' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '找到了 Calculator。' }] },
    ],
  });
  const { agent, close } = await connectAgent(runtime.open, {
    options: { model: 'relay-anthropic/claude-sonnet-5-5', gatewayUrl: 'http://127.0.0.1:3425' }, createGateway: gateway.createGateway,
  });
  try {
    const result = await agent.callTool({ name: 'computer_use', arguments: { task: '看看有没有计算器' } });
    assert.equal(result.isError, undefined);
    assert.match(text(result), /找到了 Calculator。/);
    assert.match(text(result), /执行模型：relay-anthropic\/claude-sonnet-5-5；工具调用 1 次/);
    assert.equal(gateway.requests[0].model, 'relay-anthropic/claude-sonnet-5-5');
    assert.equal(gateway.created[0].url, 'http://127.0.0.1:3425');
    // 新会话先重置运行时，执行模型的 js 调用原样交给运行时。
    assert.deepEqual(runtime.calls.map(call => call.name), ['js_reset', 'js']);
    assert.deepEqual(runtime.calls[1].args, { code: 'await cua.getState();' });
    // 截图等中间结果没有出现在返回内容中。
    assert.ok(result.content.every(part => part.type === 'text'));
  } finally {
    await close();
  }
});

test('调用参数中的 model 优先于插件选项', async () => {
  const gateway = fakeGateway({ replies: [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }] });
  const { agent, close } = await connectAgent(fakeRuntime().open, { options: { model: 'a/default' }, createGateway: gateway.createGateway });
  try {
    await agent.callTool({ name: 'computer_use', arguments: { task: 't', model: 'b/override' } });
    assert.equal(gateway.requests[0].model, 'b/override');
  } finally {
    await close();
  }
});

test('没有设置模型时返回设置方法', async () => {
  const gateway = fakeGateway();
  const { agent, close } = await connectAgent(fakeRuntime().open, { createGateway: gateway.createGateway });
  try {
    const result = await agent.callTool({ name: 'computer_use', arguments: { task: 't' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /magpie plugin options magpie-computer-use/);
    assert.equal(gateway.requests.length, 0);
  } finally {
    await close();
  }
});

test('不支持图片的模型在执行前就被拒绝', async () => {
  const gateway = fakeGateway({ models: [{ id: 'zero-cat/kimi-k3-free', modalities: { input: ['text'] }, tool_call: true }] });
  const { agent, close } = await connectAgent(fakeRuntime().open, { options: { model: 'zero-cat/kimi-k3-free' }, createGateway: gateway.createGateway });
  try {
    const result = await agent.callTool({ name: 'computer_use', arguments: { task: 't' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /不能接收截图/);
    assert.equal(gateway.requests.length, 0);
  } finally {
    await close();
  }
});

test('调用方提供 progressToken 时，每步报告进度', async () => {
  const gateway = fakeGateway({
    replies: [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'js', input: { code: 'x', title: '打开计算器' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    ],
  });
  const { agent, close } = await connectAgent(fakeRuntime().open, { options: { model: 'a/b' }, createGateway: gateway.createGateway });
  const progress = [];
  try {
    await agent.callTool({ name: 'computer_use', arguments: { task: 't', max_steps: 7 } }, undefined, {
      onprogress: update => progress.push(update),
    });
    assert.deepEqual(progress, [{ progress: 1, total: 7, message: 'js 打开计算器' }]);
  } finally {
    await close();
  }
});

test('运行时返回的错误作为工具结果交回子模型', async () => {
  const gateway = fakeGateway({
    replies: [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'js', input: { code: 'bad(' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '放弃' }] },
    ],
  });
  const runtime = fakeRuntime(async name => (name === 'js' ? { content: [{ type: 'text', text: 'SyntaxError' }], isError: true } : { content: [] }));
  const { agent, close } = await connectAgent(runtime.open, { options: { model: 'a/b' }, createGateway: gateway.createGateway });
  try {
    const result = await agent.callTool({ name: 'computer_use', arguments: { task: 't' } });
    const toolResult = gateway.requests[1].messages[2].content[0];
    assert.equal(toolResult.is_error, true);
    assert.match(toolResult.content[0].text, /SyntaxError/);
    assert.match(text(result), /失败 1 次/);
  } finally {
    await close();
  }
});

test('list_computer_use_models 只列出能接收截图并调用工具的模型，并标出默认模型', async () => {
  const gateway = fakeGateway({ models: [
    { id: 'relay-anthropic/claude-sonnet-5-5', magpie_label: 'Claude Sonnet 5.5 · relay-anthropic', ...VISION },
    { id: 'zero-cat/kimi-k3-free', modalities: { input: ['text'] }, tool_call: true },
  ] });
  const { agent, close } = await connectAgent(fakeRuntime().open, { options: { model: 'relay-anthropic/claude-sonnet-5-5' }, createGateway: gateway.createGateway });
  try {
    const result = await agent.callTool({ name: 'list_computer_use_models', arguments: {} });
    assert.match(text(result), /relay-anthropic\/claude-sonnet-5-5（Claude Sonnet 5\.5 · relay-anthropic）  ← 当前默认/);
    assert.doesNotMatch(text(result), /kimi-k3-free/);
  } finally {
    await close();
  }
});

test('插件选项写错时，调用 computer_use 返回具体错误，工具列表仍可用', async () => {
  const runtime = fakeRuntime();
  const { server, close } = createComputerUseServer({
    open: runtime.open, loadOptions: async () => normalizeOptions({ tools: 'everything' }, {}), createGateway: () => ({}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const agent = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });
  await agent.connect(clientTransport);
  try {
    const { tools } = await agent.listTools();
    // 回落到默认选项：三个委托工具加原版 js / js_reset。
    assert.deepEqual(tools.map(tool => tool.name), ['computer_use', 'look', 'list_computer_use_models', 'js', 'js_reset']);
    const result = await agent.callTool({ name: 'computer_use', arguments: { task: 't' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /tools 应为 delegate \/ direct \/ both/);
  } finally {
    await close();
  }
});

test('指令模板 mcu：可列出，取回时把任务原样放入发给 AI 的消息', async () => {
  const { agent, close } = await connectAgent(fakeRuntime().open);
  try {
    const { prompts } = await agent.listPrompts();
    assert.deepEqual(prompts.map(prompt => prompt.name), ['mcu']);
    assert.equal(prompts[0].arguments[0].name, 'task');
    assert.equal(prompts[0].arguments[0].required, true);
    const task = '在备忘录里新建一条笔记，标题 “明天 待办”';
    const result = await agent.getPrompt({ name: 'mcu', arguments: { task } });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
    assert.match(result.messages[0].content.text, /computer_use/);
    assert.ok(result.messages[0].content.text.endsWith(`任务：${task}`));
  } finally {
    await close();
  }
});

test('指令模板 mcu：tools=direct 时让 AI 用操作工具；任务为空时报错', async () => {
  const { agent, close } = await connectAgent(fakeRuntime().open, { options: { tools: 'direct' } });
  try {
    const result = await agent.getPrompt({ name: 'mcu', arguments: { task: '读取计算器的数字' } });
    assert.match(result.messages[0].content.text, /list_apps/);
    assert.doesNotMatch(result.messages[0].content.text, /computer_use 工具/);
    await assert.rejects(agent.getPrompt({ name: 'mcu', arguments: { task: '  ' } }), /请在命令后写上要完成的任务/);
    await assert.rejects(agent.getPrompt({ name: 'nope', arguments: {} }), /Unknown prompt/);
  } finally {
    await close();
  }
});

test('指令模板 mcu：Claude Code 按空格切开的参数会按顺序拼回完整任务', async () => {
  const { joinTask, promptsFor, OVERFLOW_ARGUMENTS } = await import('../src/prompts.mjs');
  assert.equal(joinTask({ task: '在', _2: 'Safari', _3: '浏览器', _10: '标题', _4: '打开' }), '在 Safari 浏览器 打开 标题');
  assert.equal(joinTask({ task: '在备忘录里新建' }), '在备忘录里新建');
  assert.equal(joinTask({ _2: 'only', other: 'x' }), 'only');
  // 只有 Claude Code 看到额外的参数；其他客户端只有一个 task 输入框
  assert.equal(promptsFor('claude-code')[0].arguments.length, 1 + OVERFLOW_ARGUMENTS);
  assert.equal(promptsFor('claude-code')[0].arguments.slice(1).every(argument => !argument.required), true);
  assert.equal(promptsFor('Claude Desktop')[0].arguments.length, 1);
});

test('指令模板 mcu：按连接的客户端名称决定声明的参数', async () => {
  const runtime = fakeRuntime();
  const loadOptions = async () => normalizeOptions({}, {});
  for (const [clientName, count] of [['claude-code', 64], ['other-client', 1]]) {
    const { server, close } = createComputerUseServer({ open: runtime.open, loadOptions, createGateway: () => ({}) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const agent = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
    await agent.connect(clientTransport);
    try {
      const { prompts } = await agent.listPrompts();
      assert.equal(prompts[0].arguments.length, count, clientName);
      const result = await agent.getPrompt({ name: 'mcu', arguments: { task: '在', _2: 'Safari', _3: '浏览器', _4: '打开' } });
      assert.ok(result.messages[0].content.text.endsWith('任务：在 Safari 浏览器 打开'));
    } finally {
      await close();
    }
  }
});

test('应用授权：三种方式（手动、跟随 Agent、直接允许）分别按预期回答运行时', async () => {
  const nativeRequest = {
    mode: 'form', message: 'Allow Computer Use to use "Calculator"?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call', tool_params: { app: 'Calculator' }, persist: ['session', 'always'] },
  };
  const runtime = fakeRuntime(async (_name, _args, _options, state) => {
    const answer = await state.onElicitation(nativeRequest, { signal: new AbortController().signal });
    return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
  });
  const cases = [
    // 手动：勾选框表单，勾选“始终允许”
    ['manual', { action: 'accept', content: { session: true, always: true } }, { action: 'accept', content: {}, _meta: { persist: 'always' } }, 1],
    // 跟随 Agent 但读不到权限模式：按手动授权询问
    ['agent', { action: 'accept', content: { session: true } }, { action: 'accept', content: {}, _meta: { persist: 'session' } }, 1],
    // 直接允许：不询问
    ['auto', { action: 'decline' }, { action: 'accept', content: {}, _meta: { persist: 'session' } }, 0],
  ];
  for (const [approval, reply, expected, prompts] of cases) {
    const shown = [];
    const { agent, close } = await connectAgent(runtime.open, { options: { approval }, onElicit: async params => { shown.push(params); return reply; } });
    try {
      const result = await agent.callTool({ name: 'list_apps', arguments: {} });
      assert.deepEqual(JSON.parse(text(result)), expected, approval);
      assert.equal(shown.length, prompts, approval);
      if (approval === 'manual') assert.deepEqual(Object.keys(shown[0].requestedSchema.properties), ['session', 'always']);
      if (approval === 'agent') assert.deepEqual(Object.keys(shown[0].requestedSchema.properties), ['session', 'always']);
    } finally {
      await close();
    }
  }
});

test('应用授权：直接允许也不会批准 magpie 自身', async () => {
  const hostRequest = {
    mode: 'form', message: 'Allow Computer Use to use "magpie"?', requestedSchema: { type: 'object', properties: {} },
    _meta: { connector_id: 'computer-use', tool_params: { app: 'com.yetone.magpie' }, persist: ['session', 'always'] },
  };
  const runtime = fakeRuntime(async (_name, _args, _options, state) => ({
    content: [{ type: 'text', text: JSON.stringify(await state.onElicitation(hostRequest, { signal: new AbortController().signal })) }],
  }));
  const { agent, close } = await connectAgent(runtime.open, { options: { approval: 'auto' } });
  try {
    assert.deepEqual(JSON.parse(text(await agent.callTool({ name: 'list_apps', arguments: {} }))), { action: 'decline' });
  } finally {
    await close();
  }
});

test('跟随 Agent：按这次调用的 Claude Code 权限模式决定允许、询问或拒绝', async () => {
  const nativeRequest = {
    mode: 'form', message: 'Allow Computer Use to use "Calculator"?', requestedSchema: { type: 'object', properties: {} },
    _meta: { connector_id: 'computer-use', tool_params: { app: 'Calculator' }, persist: ['session', 'always'] },
  };
  const runtime = fakeRuntime(async (_name, _args, _options, state) => ({
    content: [{ type: 'text', text: JSON.stringify(await state.onElicitation(nativeRequest, { signal: new AbortController().signal })) }],
  }));
  const cases = [
    ['bypassPermissions', { action: 'accept', content: {}, _meta: { persist: 'session' } }, 0],
    ['auto', { action: 'accept', content: {}, _meta: { persist: 'session' } }, 0],
    ['acceptEdits', { action: 'accept', content: {}, _meta: { persist: 'always' } }, 1],
    ['default', { action: 'accept', content: {}, _meta: { persist: 'always' } }, 1],
    ['plan', { action: 'decline' }, 0],
  ];
  for (const [mode, expected, prompts] of cases) {
    const asked = [];
    const seenIds = [];
    const { agent, close } = await connectAgent(runtime.open, {
      options: { approval: 'agent' },
      modeOf: async id => { seenIds.push(id); return mode; },
      onElicit: async params => { asked.push(params); return { action: 'accept', content: { session: true, always: true } }; },
    });
    try {
      const result = await agent.callTool({ name: 'list_apps', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_123' } });
      assert.deepEqual(JSON.parse(text(result)), expected, mode);
      assert.equal(asked.length, prompts, mode);
      assert.deepEqual(seenIds, ['toolu_123'], mode);
    } finally {
      await close();
    }
  }
});

// 测试用的会话存储：证据写到临时目录，结束后删除。
async function tempSessions() {
  const { createSessionStore } = await import('../src/sessions.mjs');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcu-evidence-'));
  return { sessions: createSessionStore({ directory }), directory, cleanup: () => fs.rm(directory, { recursive: true, force: true }), fs };
}

async function connectWithSessions(runtime, gateway, sessions, options = {}) {
  const loadOptions = async () => normalizeOptions({ model: 'a/b', ...options }, {});
  const { server, close } = createComputerUseServer({ open: runtime.open, loadOptions, createGateway: gateway.createGateway, sessions });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const agent = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });
  await agent.connect(clientTransport);
  return { agent, close };
}

const PNG = { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' };

test('computer_use 返回证据截图（原图与文件）和 session_id，带上 session_id 可继续', async () => {
  const runtime = fakeRuntime(async name => (name === 'js' ? { content: [{ type: 'text', text: 'AX' }, PNG] } : { content: [] }));
  const gateway = fakeGateway({
    replies: [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'j1', name: 'js', input: { code: 'shot' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '看到的事实：首页 #1 有登录按钮。' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '已往下滚。' }] },
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'j2', name: 'js', input: { code: 'shot' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '底部 #2' }] },
    ],
  });
  const store = await tempSessions();
  const { agent, close } = await connectWithSessions(runtime, gateway, store.sessions, { evidenceImages: 1 });
  try {
    const first = await agent.callTool({ name: 'computer_use', arguments: { task: '打开首页截图给我' } });
    const id = /session_id：(\S+?)。/.exec(text(first))?.[1];
    assert.ok(id);
    assert.match(text(first), /#1 首页（已附在下方；.+01-首页\.png）/);
    assert.deepEqual(first.content.filter(part => part.type === 'image'), [PNG]);
    const file = /；(\/.+?01-首页\.png)）/.exec(text(first))[1];
    assert.equal((await store.fs.readFile(file)).toString(), 'png-bytes');

    const second = await agent.callTool({ name: 'computer_use', arguments: { task: '再往下滚', session_id: id } });
    assert.match(text(second), /已往下滚。/);
    assert.match(text(second), new RegExp(`session_id：${id}`));
    const continued = gateway.requests.at(-1).messages;
    assert.equal(continued[0].content, '打开首页截图给我');
    assert.match(JSON.stringify(continued.at(-1)), /后续指令/);

    const third = await agent.callTool({ name: 'computer_use', arguments: { task: '再截一张', session_id: id } });
    assert.match(text(third), /#2 底部（已附在下方；.+02-底部\.png）/);
    assert.match(JSON.stringify(gateway.requests.at(-1).messages.at(-1)), /截图已存为证据 #2/);

    const missing = await agent.callTool({ name: 'computer_use', arguments: { task: 'x', session_id: 'nope' } });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /不存在或已过期/);
  } finally {
    await close();
    await store.cleanup();
  }
});

test('look 只返回截图，不返回界面树', async () => {
  const runtime = fakeRuntime(async (_name, args) => (args.code.includes('getScreenshot') ? { content: [PNG] } : { content: [{ type: 'text', text: '很长的界面树' }] }));
  const store = await tempSessions();
  const { agent, close } = await connectWithSessions(runtime, fakeGateway({ replies: [] }), store.sessions, { tools: 'delegate' });
  try {
    const result = await agent.callTool({ name: 'look', arguments: { app: 'Safari' } });
    assert.equal(result.isError, undefined);
    assert.doesNotMatch(text(result), /界面树/);
    assert.deepEqual(result.content.filter(part => part.type === 'image'), [PNG]);
  } finally {
    await close();
    await store.cleanup();
  }
});

test('执行模型拿到原始指令与原版 js 工具（与 ChatGPT 一致），结果原样转交；新会话先重置，续接不重置', async () => {
  const LONG = 'x'.repeat(50_000);
  const runtime = fakeRuntime(async name => (name === 'js_reset' ? { content: [{ type: 'text', text: 'reset' }] } : { content: [{ type: 'text', text: LONG }, PNG] }));
  const gateway = fakeGateway({
    replies: [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'j1', name: 'js', input: { code: 'let app = await cua.getApp("Safari");', title: '打开 Safari' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '看到的事实：首页。' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '继续了。' }] },
    ],
  });
  const store = await tempSessions();
  const { agent, close } = await connectWithSessions(runtime, gateway, store.sessions);
  try {
    const first = await agent.callTool({ name: 'computer_use', arguments: { task: '看看 Safari 首页' } });
    const body = gateway.requests[0];
    assert.ok(body.system.startsWith('UI automation through cua_repl using the initialized cua API.'));
    assert.match(body.system, /Delegation rules/);
    assert.deepEqual(body.tools.map(tool => tool.name), ['js', 'js_reset']);
    assert.equal(body.tools[0].description, 'ORIGINAL JS DESCRIPTION');
    assert.deepEqual(runtime.calls.map(call => call.name), ['js_reset', 'js']);
    assert.deepEqual(runtime.calls[1].args, { code: 'let app = await cua.getApp("Safari");', title: '打开 Safari' });
    const id = /session_id：(\S+?)。/.exec(text(first))[1];
    assert.equal(runtime.calls[0].options.turnId, id);
    assert.equal(runtime.calls[1].options.turnId, id);
    assert.equal(runtime.calls[1].options.model, 'a/b');
    assert.equal(gateway.requests[1].messages[2].content[0].content[0].text.length, 50_000);

    await agent.callTool({ name: 'computer_use', arguments: { task: '再往下滚', session_id: id } });
    assert.deepEqual(runtime.calls.map(call => call.name), ['js_reset', 'js'], '续接不重置运行时');
  } finally {
    await close();
    await store.cleanup();
  }
});

test('LCU 不提供原版工具定义时给出可操作的错误', async () => {
  const runtime = fakeRuntime();
  const open = async options => {
    const opened = await runtime.open(options);
    return { ...opened, client: { ...opened.client, publicTools: undefined } };
  };
  const store = await tempSessions();
  const { agent, close } = await connectWithSessions({ ...runtime, open }, fakeGateway({ replies: [] }), store.sessions);
  try {
    const result = await agent.callTool({ name: 'computer_use', arguments: { task: 't' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /更新到 0\.13/);
  } finally {
    await close();
    await store.cleanup();
  }
});

test('direct=original：Agent 直接拿到原版 js / js_reset，调用原样交给 Agent 自己的运行时；委托与 look 用另一个连接', async () => {
  let opens = 0;
  const runtimes = [];
  const open = async options => {
    opens += 1;
    const runtime = fakeRuntime(async name => (name === 'js' ? { content: [{ type: 'text', text: 'ok' }, PNG] } : { content: [{ type: 'text', text: 'AX' }, PNG] }));
    runtimes.push(runtime);
    return runtime.open(options);
  };
  const store = await tempSessions();
  const { agent, close } = await connectWithSessions({ open }, fakeGateway({ replies: [] }), store.sessions, { tools: 'both', direct: 'original' });
  try {
    const { tools } = await agent.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['computer_use', 'look', 'list_computer_use_models', 'js', 'js_reset']);
    assert.equal(tools[3].description, 'ORIGINAL JS DESCRIPTION');
    const result = await agent.callTool({ name: 'js', arguments: { code: 'await cua.getState();' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(runtimes[0].calls.map(call => [call.name, call.args]), [['js', { code: 'await cua.getState();' }]]);
    const rejected = await agent.callTool({ name: 'click', arguments: { app: 'X', element_index: '1' } });
    assert.equal(rejected.isError, true);
    await agent.callTool({ name: 'look', arguments: { app: 'Safari' } });
    assert.equal(opens, 2, 'look 用委托的运行时连接');
    assert.equal(runtimes[0].calls.length, 1, 'Agent 的运行时没有被 look 占用');
  } finally {
    await close();
    await store.cleanup();
  }
});

test('浏览器开关：开启时先确保连接器指向 LCU，再以 lcu --chrome 启动；关闭时不碰连接器', async () => {
  const commands = [];
  const connected = [];
  const discover = async () => ({ version: '0.13.4', launcher: '/fake/bin/lcu' });
  const loadClient = async () => ({ command }) => {
    commands.push(command);
    return { connect: async () => {}, call: async () => {}, turnEnded: async () => {}, close: async () => {} };
  };
  const connectBrowser = async launcher => { connected.push(launcher); return { connector: 'lcu' }; };
  await openLcuRuntime({ discover, loadClient, connectBrowser, chrome: true });
  await openLcuRuntime({ discover, loadClient, connectBrowser });
  assert.deepEqual(commands, [['/fake/bin/lcu', '--chrome'], ['/fake/bin/lcu']]);
  assert.deepEqual(connected, ['/fake/bin/lcu']);
});

test('浏览器开关改变后，下一次调用以新的方式重建运行时，旧连接结束轮次并关闭', async () => {
  const opened = [];
  const clients = [];
  const open = async ({ chrome }) => {
    const client = {
      closed: false, ended: [],
      call: async () => ({ content: [{ type: 'text', text: `chrome=${chrome}` }] }),
      turnEnded: async identity => { client.ended.push(identity); },
      close: async () => { client.closed = true; },
      instructions: '', publicTools: () => [],
    };
    opened.push(chrome);
    clients.push(client);
    return { info: { version: '0.13.4' }, client };
  };
  const settings = { direct: 'wrapped', chrome: false };
  const { server, close } = createComputerUseServer({ open, loadOptions: async () => normalizeOptions(settings, {}), createGateway: () => ({}) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const agent = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });
  await agent.connect(clientTransport);
  try {
    assert.match(text(await agent.callTool({ name: 'list_apps', arguments: {} })), /chrome=false/);
    assert.match(text(await agent.callTool({ name: 'list_apps', arguments: {} })), /chrome=false/);
    settings.chrome = true;
    assert.match(text(await agent.callTool({ name: 'list_apps', arguments: {} })), /chrome=true/);
    assert.deepEqual(opened, [false, true]);
    assert.equal(clients[0].closed, true);
    assert.equal(clients[0].ended.length, 1, '旧连接上用过的轮次已结束');
  } finally {
    await close();
  }
});

test('网站访问授权：直接允许时接受，手动时原样转交 Agent', async () => {
  const siteRequest = {
    mode: 'form', message: 'Allow access to https://www.marriott.com.cn?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { tool_name: 'access_browser_origin', origin: 'https://www.marriott.com.cn' },
  };
  const runtime = fakeRuntime(async (_name, _args, _options, state) => {
    const answer = await state.onElicitation(siteRequest, { signal: new AbortController().signal });
    return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
  });
  for (const [approval, prompts, expected] of [['auto', 0, { action: 'accept', content: {} }], ['manual', 1, { action: 'accept', content: {} }]]) {
    const shown = [];
    const { agent, close } = await connectAgent(runtime.open, { options: { approval }, onElicit: async params => { shown.push(params); return { action: 'accept', content: {} }; } });
    try {
      const result = await agent.callTool({ name: 'list_apps', arguments: {} });
      assert.deepEqual(JSON.parse(text(result)), expected, approval);
      assert.equal(shown.length, prompts, approval);
      if (prompts) assert.equal(shown[0].message, siteRequest.message);
    } finally {
      await close();
    }
  }
});
