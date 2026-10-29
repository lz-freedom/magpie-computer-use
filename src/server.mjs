/**
 * 面向 Agent 的 stdio MCP 服务。
 * - 十个原生工具：经本机已安装 LCU 的官方共享客户端调用原始运行时。
 * - computer_use：把任务交给插件选项（或调用参数）指定的模型，由它经 magpie 网关、以与 ChatGPT 相同的方式
 *   （原版 js / js_reset 工具与指令）操作应用；
 *   返回事实报告、证据截图与 session_id，调用方 Agent 可带上 session_id 继续指挥。
 * - look：只截图不操作，供调用方 Agent 自己核实界面。
 * LCU 在首次需要时才发现与连接，失败不会缓存，因此安装或修复 LCU 之后下一次调用即可生效。
 * 每个 MCP 连接都有独立的运行时上下文；连接关闭时结束其中用过的宿主轮次，并释放 LCU 连接。
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { executorToolset, formatDelegatedResult, runDelegatedTask } from './agent.mjs';
import { appApproval, approvalAnswer, approvalForm, browserOrigin, sessionAnswer } from './approval.mjs';
import { decisionFor, readMode } from './claude-hook.mjs';
import { PLUGIN_NAME, VERSION } from './config.mjs';
import { codexCommand, codexPrompt, runCodexTask } from './codex.mjs';
import { createSessionStore } from './sessions.mjs';
import { createGatewayClient, formatModelList, supportsComputerUse } from './gateway.mjs';
import { assertCompatible, discoverLcu, ensureBrowserConnector, loadLcuClient } from './lcu.mjs';
import { DEFAULT_OPTIONS, readPluginOptions } from './options.mjs';
import { buildPrompt, promptsFor } from './prompts.mjs';
import {
  DELEGATE_INSTRUCTIONS, DELEGATE_TOOLS, DELEGATE_TOOL_NAMES, NATIVE_INSTRUCTIONS, NATIVE_TOOLS, NATIVE_TOOL_NAMES,
  buildSteps, validateArguments,
} from './tools.mjs';

// 这些应用是 Agent 所在的宿主，授权它们等于让 Agent 批准自己；直接拒绝，不交给用户确认。
const BLOCKED_APPS = new Set(['com.yetone.magpie']);

/** 原始运行时的授权请求若针对宿主应用，直接拒绝。 */
export function blockedApproval(params) {
  return params?._meta?.connector_id === 'computer-use' &&
    BLOCKED_APPS.has(String(params?._meta?.tool_params?.app ?? '').toLowerCase());
}

/** 宿主若提供了真实的会话与轮次元数据（x-codex-turn-metadata），沿用之，否则返回 undefined。 */
export function hostIdentity(meta) {
  let value = meta?.['x-codex-turn-metadata'];
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (value && typeof value === 'object' && typeof value.session_id === 'string' && typeof value.turn_id === 'string' &&
      value.session_id && value.turn_id) {
    return { sessionId: value.session_id, turnId: value.turn_id };
  }
  return undefined;
}

/**
 * 按 tools 选项决定对 Agent 暴露的工具。直接操作的工具按 direct 选项：original 为运行时提供的原版
 * js / js_reset（originalTools，取不到时为空），wrapped 为插件包装的十个工具。
 */
export function exposedTools(mode, { direct = 'original', originalTools = [] } = {}) {
  const directTools = direct === 'original' ? originalTools : NATIVE_TOOLS;
  if (mode === 'delegate') return DELEGATE_TOOLS;
  if (mode === 'direct') return directTools;
  return [...DELEGATE_TOOLS, ...directTools];
}

/** Agent 直接使用原版 js 工具时的 MCP 说明：操作方法以工具说明与首次调用返回的文档为准。 */
export const ORIGINAL_DIRECT_INSTRUCTIONS = 'This MCP exposes the original ChatGPT Computer Use tools js and js_reset (UI automation through cua_repl using the initialized cua API). Follow their descriptions and the documentation returned by the first js call.';

/**
 * 发现并连接当前安装的 LCU。版本或布局不满足时抛出带诊断信息的错误。
 * chrome：先确保 Chrome 连接器指向本 LCU（必要时运行 lcu browser install），再以 lcu --chrome 启动，
 * 运行时随之提供 ChatGPT 原版的浏览器 API 与说明。
 */
export async function openLcuRuntime({
  onElicitation, chrome = false, discover = discoverLcu, loadClient = loadLcuClient, connectBrowser = ensureBrowserConnector,
} = {}) {
  const info = await discover();
  assertCompatible(info);
  const createCuaClient = await loadClient(info);
  if (chrome) await connectBrowser(info.launcher);
  const client = createCuaClient({ command: [info.launcher, ...(chrome ? ['--chrome'] : [])], onElicitation, adapter: PLUGIN_NAME });
  // 插件只依赖这四个方法；LCU 改动接口时在此明确报错，而不是在工具调用时出现难以理解的错误。
  const missing = ['connect', 'call', 'turnEnded', 'close'].filter(name => typeof client?.[name] !== 'function');
  if (missing.length) throw new Error(`LCU ${info.version} 的共享客户端缺少 ${missing.join('、')}；请更新 LCU 或插件。`);
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return { info, client };
}

const ORIGINAL_TOOL_NAMES = new Set(['js', 'js_reset']);

const errorResult = message => ({ content: [{ type: 'text', text: message }], isError: true });

export function createComputerUseServer({
  open = openLcuRuntime, loadOptions = readPluginOptions, createGateway = createGatewayClient, modeOf = readMode,
  sessions = createSessionStore(), direct = 'original',
} = {}) {
  const server = new Server(
    { name: PLUGIN_NAME, version: VERSION },
    { capabilities: { tools: {}, prompts: {} }, instructions: `${DELEGATE_INSTRUCTIONS}\n\n${direct === 'original' ? ORIGINAL_DIRECT_INSTRUCTIONS : NATIVE_INSTRUCTIONS}` },
  );
  // 宿主没有提供真实轮次元数据时，整条 MCP 连接共用这一上下文，直到连接关闭。
  const connection = { sessionId: randomUUID(), turnId: randomUUID() };
  const usedTurns = new Map();
  // 进行中的工具调用 → Claude Code 的 toolUseId，用于在授权询问时找到这次调用的权限模式。
  const activeCalls = new Map();
  // 两个运行时连接：agent 供 Agent 直接操作，delegate 供执行模型与 look。运行时的 JS 环境是全局的，
  // 委托会话开始时会重置它；分开连接，委托就不会清掉 Agent 自己建立的变量与应用绑定。
  const runtimes = new Map();
  let closed = false;

  // 原始运行时的授权请求按插件选项 approval 处理，其余请求转交给调用方 Agent。
  // 宿主应用（magpie 等）一律拒绝；LCU 客户端在此之前也会拒绝已知的 Agent 宿主与终端。
  async function relayElicitation(params, { signal } = {}) {
    if (blockedApproval(params)) return { action: 'decline' };
    if (closed || signal?.aborted) return { action: 'cancel' };
    const approval = appApproval(params);
    // 浏览器模式下运行时第一次访问某个网站时也会询问；按同样的授权方式处理，询问时原样转交。
    const site = approval ? null : browserOrigin(params);
    let mode = approval || site ? (await currentOptions()).options.approval : null;
    // 跟随 Agent：按钩子记录的权限模式决定；读不到（其他 Agent、钩子未安装）时按手动授权询问。
    if (mode === 'agent') {
      const ids = [...activeCalls.values()].filter(Boolean);
      const decision = decisionFor(ids.length ? await modeOf(ids.at(-1)) : null);
      if (decision === 'allow') return site ? { action: 'accept', content: {} } : sessionAnswer(approval);
      if (decision === 'decline') return { action: 'decline' };
      mode = 'manual';
    }
    if (mode === 'auto') return site ? { action: 'accept', content: {} } : sessionAnswer(approval);
    if (!server.getClientCapabilities()?.elicitation) return { action: 'cancel' };
    try {
      // 手动授权：改写为勾选框表单，否则客户端只能回答“仅此一次”，每一步都会再问。
      const answer = await server.elicitInput(approval ? approvalForm(params, approval) : params, { signal, timeout: 2 ** 31 - 1 });
      if (approval) return approvalAnswer(approval, answer);
      return ['accept', 'decline', 'cancel'].includes(answer?.action) ? answer : { action: 'cancel' };
    } catch {
      return { action: 'cancel' };
    }
  }

  // 失败时清除缓存，下一次调用重新发现 LCU，使安装、更新或修复之后无需重启 Agent。
  // 浏览器开关改变后，下一次调用以新的方式重新启动运行时（旧连接上的轮次随之结束）。
  async function ensureRuntime(kind = 'agent') {
    if (closed) throw new Error('Computer Use 连接已关闭。');
    const chrome = Boolean((await currentOptions()).options.chrome);
    const current = runtimes.get(kind);
    if (current && current.chrome !== chrome) {
      runtimes.delete(kind);
      await retire(kind, current.promise);
    }
    if (!runtimes.has(kind)) {
      const promise = open({ onElicitation: relayElicitation, chrome }).catch(error => {
        if (runtimes.get(kind)?.promise === promise) runtimes.delete(kind);
        throw error;
      });
      runtimes.set(kind, { chrome, promise });
    }
    return runtimes.get(kind).promise;
  }

  // 结束某个运行时连接上用过的轮次并关闭它。
  async function retire(kind, promise) {
    const { client } = await promise.catch(() => ({}));
    for (const [key, used] of usedTurns) {
      if (used.kind !== kind) continue;
      usedTurns.delete(key);
      if (client) await client.turnEnded({ ...used.identity, event: 'Stop' }).catch(() => {});
    }
    await client?.close().catch(() => {});
  }

  // 记下用过的轮次，连接关闭时在对应的运行时上结束它们。
  function useTurn(kind, identity) {
    usedTurns.set(`${kind}\0${identity.sessionId}\0${identity.turnId}`, { kind, identity });
  }

  /** Agent 直接操作时暴露的原版工具；运行时不可用时为空（调用时会给出具体错误）。 */
  async function originalTools(options) {
    if (options.direct !== 'original' || options.tools === 'delegate') return [];
    try {
      const { client } = await ensureRuntime('agent');
      return typeof client.publicTools === 'function' ? client.publicTools() : [];
    } catch {
      return [];
    }
  }

  // 选项读取失败（例如 JSON 写错）时，工具列表仍按默认值提供，具体错误在调用时返回。
  async function currentOptions() {
    try { return { options: await loadOptions() }; } catch (error) { return { options: DEFAULT_OPTIONS, error }; }
  }

  /** 执行一个原生工具，总是返回 MCP 结果（错误也作为工具结果返回）。 */
  async function executeNative(name, input, { identity, meta, signal, kind = 'agent' }) {
    try {
      const args = validateArguments(name, input ?? {}, NATIVE_TOOLS);
      const steps = buildSteps(name, args, identity);
      const { client } = await ensureRuntime(kind);
      useTurn(kind, identity);
      const content = [];
      for (const step of steps) {
        const result = await client.call('js', { code: step.code, title: step.title }, { ...identity, metadata: meta, signal });
        // 图片、文字与错误保持原样返回，isError 不做改写。
        content.push(...(result.content ?? []));
        if (result.isError) return { content, isError: true };
      }
      return { content };
    } catch (error) {
      if (signal?.aborted) throw error;
      return errorResult(error.message);
    }
  }

  /** 把执行模型的 js / js_reset 调用原样交给运行时（与 ChatGPT 一致），总是返回 MCP 结果。 */
  async function executeOriginal(name, args, { identity, meta, model, signal, kind = 'delegate' }) {
    try {
      const { client } = await ensureRuntime(kind);
      useTurn(kind, identity);
      return await client.call(name, args, { ...identity, metadata: meta, model, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return errorResult(error.message);
    }
  }

  /** 执行模型的工具与指令：取自当前连接的原始运行时。 */
  async function executorSet() {
    const { client } = await ensureRuntime('delegate');
    if (typeof client.publicTools !== 'function') throw new Error('当前 LCU 不提供原版工具定义（publicTools）；请把 LCU 更新到 0.13 或更新的版本。');
    return executorToolset({ instructions: client.instructions ?? '', tools: client.publicTools() });
  }

  async function listModels(options) {
    const gateway = createGateway({ url: options.gatewayUrl, key: options.gatewayKey });
    const models = await gateway.listModels();
    return { content: [{ type: 'text', text: formatModelList(models, { url: gateway.url, defaultModel: options.model }) }] };
  }

  // look：选择应用后只返回截图，不把界面树交给调用方，也不做任何操作。
  async function look(args, context) {
    // 在委托用的运行时上截图，不占用 Agent 直接操作的 JS 环境（也不会提前用掉它首次调用返回的文档）。
    const result = await executeNative('get_app_state', { app: args.app }, { ...context, kind: 'delegate' });
    if (result.isError) return result;
    const images = result.content.filter(part => part?.type === 'image');
    if (!images.length) return errorResult(`没有拿到 ${args.app} 的截图。`);
    return { content: [{ type: 'text', text: `${args.app} 当前窗口的截图（只看，未做任何操作）：` }, images.at(-1)] };
  }

  async function delegate(args, { identity, meta, signal, progress }) {
    const { options, error } = await currentOptions();
    if (error) return errorResult(error.message);
    let session;
    if (args.session_id) {
      session = sessions.get(args.session_id);
      if (!session) return errorResult(`session_id ${args.session_id} 不存在或已过期（闲置 30 分钟或 MCP 重连后失效）。请不带 session_id 重新调用 computer_use。`);
    }
    const model = args.model ?? options.model;
    if (!model) return errorResult('没有可用的模型：请在调用时传入 model，或用 magpie plugin options magpie-computer-use \'{"model":"provider/model"}\' 设置默认模型。');
    const gateway = createGateway({ url: options.gatewayUrl, key: options.gatewayKey });
    // 模型若明确不支持图片或工具，提前给出可操作的错误；网关不可用时交给实际请求报告。
    if (model) {
      const found = await gateway.listModels({ signal }).then(models => models.find(item => item.id === model), () => undefined);
      if (found && supportsComputerUse(found) === false) {
        return errorResult(`模型 ${model} 不能接收截图或不支持工具调用，无法执行 computer_use。可用 list_computer_use_models 查看可用模型。`);
      }
    }
    const maxSteps = args.max_steps ?? options.maxSteps;
    const via = session?.via ?? options.delegateVia;
    if (via === 'codex') return delegateToCodex({ args, options, model, session, signal, progress, maxSteps });
    let toolset;
    try { toolset = await executorSet(); } catch (failure) { return errorResult(failure.message); }
    // 每个委托会话是运行时的一个轮次。运行时的 JS 环境是全局的，使用指南只在首次调用时返回，
    // 所以新会话先重置，执行模型像在 ChatGPT 中新开对话一样从头拿到完整指南；续接时不重置。
    if (!session) {
      session = sessions.create();
      const reset = await executeOriginal('js_reset', {}, { identity: { sessionId: connection.sessionId, turnId: session.id }, meta, model, signal });
      if (reset.isError) return reset;
    }
    const turn = { sessionId: connection.sessionId, turnId: session.id };
    const execute = (name, input, request) => executeOriginal(name, input, { identity: turn, meta, model, signal: request.signal });
    const result = await runDelegatedTask({
      task: args.task, app: args.app, model, maxSteps, history: session?.messages ?? null, lastImage: session?.lastImage, evidenceOffset: session?.evidence ?? 0,
      maxTokens: options.maxTokens, toolset, effort: options.executorEffort,
      createMessage: (body, request) => gateway.createMessage(body, request),
      execute,
      signal,
      onStep: step => progress?.(step.index, maxSteps, `${step.tool}${step.input.title ? ` ${step.input.title}` : step.input.label ? ` ${step.input.label}` : ''}${step.isError ? '（失败）' : ''}`),
    });
    sessions.update(session, result);
    const evidence = await sessions.saveEvidence(session, result.screenshots);
    return formatDelegatedResult(result, {
      includeScreenshot: args.include_screenshot === true, evidence,
      maxImages: args.max_images ?? options.evidenceImages, sessionId: session.id,
    });
  }

  // Codex 的推理强度没有 max，取最接近的 xhigh；auto 不指定。
  function codexEffort(effort) {
    if (!effort || effort === 'auto') return undefined;
    return effort === 'max' ? 'xhigh' : effort;
  }

  // 委托给 Codex：执行模型在 Codex 的官方 Harness 里用官方 Computer Use 插件操作；续接用 Codex 的 thread。
  async function delegateToCodex({ args, options, model, session, signal, progress, maxSteps }) {
    session ??= sessions.create();
    const instruction = args.app ? `${args.task}\n\n目标应用：${args.app}` : args.task;
    let run;
    try {
      run = await runCodexTask({
        command: codexCommand(options.codexPath), model, effort: codexEffort(options.executorEffort),
        prompt: codexPrompt(instruction, { followUp: Boolean(session.codexThread) }), threadId: session.codexThread ?? null, signal,
        onStep: step => progress?.(step.index, maxSteps, `${step.tool}${step.isError ? '（失败）' : ''}`),
      });
    } catch (failure) {
      if (signal?.aborted) throw failure;
      return errorResult(failure.message);
    }
    if (run.error && !run.text) return errorResult(run.error);
    session.via = 'codex';
    session.codexThread = run.threadId;
    sessions.update(session, { messages: null, lastImage: undefined });
    const result = { model: `${model}（Codex）`, text: run.text, stopReason: run.stopReason, steps: run.steps, usage: run.usage };
    return formatDelegatedResult(result, { sessionId: session.id });
  }

  // 指令模板（斜杠命令）：参数原样交给模板，按当前 tools 选项决定让 AI 委托还是直接操作。
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: promptsFor(server.getClientVersion()?.name) }));
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    const { options } = await currentOptions();
    return buildPrompt(request.params.name, request.params.arguments ?? {}, { tools: options.tools, direct: options.direct });
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { options } = await currentOptions();
    return { tools: exposedTools(options.tools, { direct: options.direct, originalTools: await originalTools(options) }) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: input, _meta: meta } = request.params;
    const identity = hostIdentity(meta) ?? connection;
    const call = Symbol(name);
    activeCalls.set(call, typeof meta?.['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId'] : null);
    try {
      const { options } = await currentOptions();
      const originalDirect = options.direct === 'original' && options.tools !== 'delegate';
      // Agent 直接使用原版 js / js_reset：原样交给 Agent 自己的运行时连接。
      if (originalDirect && ORIGINAL_TOOL_NAMES.has(name)) {
        return await executeOriginal(name, input ?? {}, { identity, meta, signal: extra.signal, kind: 'agent' });
      }
      const allowed = exposedTools(options.tools, { direct: options.direct, originalTools: [...ORIGINAL_TOOL_NAMES].map(tool => ({ name: tool })) });
      if (!allowed.some(tool => tool.name === name)) {
        const known = NATIVE_TOOL_NAMES.has(name) || DELEGATE_TOOL_NAMES.has(name) || ORIGINAL_TOOL_NAMES.has(name);
        return errorResult(known ? `当前插件选项 tools=${options.tools}、direct=${options.direct}，未开放工具 ${name}。` : `Unknown tool: ${name}`);
      }
      if (NATIVE_TOOL_NAMES.has(name)) return await executeNative(name, input, { identity, meta, signal: extra.signal });
      const args = validateArguments(name, input ?? {}, DELEGATE_TOOLS);
      if (name === 'list_computer_use_models') return await listModels(options);
      if (name === 'look') return await look(args, { identity, meta, signal: extra.signal });
      // 调用方提供了 progressToken 时，每完成一个工具调用就报告一次进度，长任务不会被误判为无响应。
      const token = meta?.progressToken;
      const progress = token === undefined ? undefined : (done, total, message) => extra.sendNotification({
        method: 'notifications/progress', params: { progressToken: token, progress: done, total, message },
      }).catch(() => {});
      return await delegate(args, { identity, meta, signal: extra.signal, progress });
    } catch (error) {
      return errorResult(error.message);
    } finally {
      activeCalls.delete(call);
    }
  });

  async function close() {
    if (closed) return;
    closed = true;
    const pending = [...runtimes.entries()];
    runtimes.clear();
    for (const [kind, { promise }] of pending) await retire(kind, promise);
    usedTurns.clear();
  }

  server.onclose = () => { void close(); };
  return { server, close };
}

/** `magpie-computer-use mcp` 的入口：在 stdio 上提供 MCP，直到宿主关闭连接。 */
export async function serveStdio({ input = process.stdin, output = process.stdout } = {}) {
  // MCP 说明在连接时发出，因此先读一次选项，决定说明直接操作用哪套工具。
  const direct = await readPluginOptions().then(options => options.direct, () => 'original');
  const { server, close } = createComputerUseServer({ direct });
  const transport = new StdioServerTransport(input, output);
  const stop = () => { void close().finally(() => process.exit(0)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await server.connect(transport);
  return { server, close };
}
