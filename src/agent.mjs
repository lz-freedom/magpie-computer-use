/**
 * 委托执行：把一个用自然语言描述的电脑操作任务交给指定模型。模型经 magpie 网关（Anthropic Messages 格式）
 * 操作应用，直到完成任务或达到步数上限。magpie 按供应商设置把请求转成上游接口的格式。
 *
 * 与 ChatGPT 中一致：执行模型只拿到原始运行时的初始化指令和原版 js / js_reset 工具定义，工具调用原样交给运行时，
 * 结果原样转交（包括首次调用返回的完整使用指南），不截断文字、不裁剪截图。插件只另加委托规则。
 *
 * 执行与判断分开：执行模型负责找到界面、操作和截图；对比、美观、对错等判断交还调用方 Agent。
 * js 返回的每张截图都自动编号存为证据（结果末尾注明 #n），不多花模型往返；执行模型在报告里引用编号，
 * 调用方 Agent 拿到报告与被引用的截图后自己下结论。
 * 返回的 messages 可在下一次调用时继续（多轮委托），由调用方 Agent 边看边指挥。
 */

const ROLE = `You operate apps on the user's Mac on behalf of another AI agent (the delegating agent). You are its hands and eyes; the delegating agent is the one who judges and decides. You run unattended: nobody answers questions mid-task, and only your final message and the screenshots it cites are shown to the delegating agent. It may send you follow-up instructions later in this same conversation.`;

/** 委托规则：只讲委托与汇报，操作方法完全来自原始运行时的指令、工具说明与返回的指南。 */
export const DELEGATION_PROMPT = `${ROLE}

Delegation rules:
- Do only what the task asks. Do not send messages, submit forms, delete data, make purchases, or change settings unless the task explicitly asks for it; nobody is available to confirm.
- If an app is not approved for Computer Use, or you are blocked, stop and explain what is needed.

Evidence:
- Screenshots that js returns are saved automatically as evidence; the tool result ends with the number, like "#3".
- Screenshots are large and every later step re-reads them, so each one slows the rest of the task. Work from the accessibility text when it is enough. Return a screenshot when you need to see the screen, or when the task asks to compare, check appearance or layout, verify a visual result, or show something.
- In the final report, cite the numbers of screenshots you already took that show the facts you report, right after the fact (for example "方案 A 首页 #3"). Cite only screenshots worth the delegating agent's look; don't take new ones just to cite them.

Final report (in the user's language), facts only:
- 做了什么: the actions you took, briefly.
- 看到的事实: what is on screen and the information the task asked for (texts, values, element names, positions, colors), citing the screenshots that show them (#n).
- 未完成: anything left undone and why.
Do not judge quality, beauty, or which option is better, and do not make decisions that belong to the delegating agent, unless the task explicitly asks for your opinion. If it does, put your opinion in a separate section titled "执行模型的看法" after the facts, and back it with cited screenshots.`;

/** 执行模型的系统提示与工具：原始初始化指令 + 委托规则；原版 js / js_reset 定义（原样）。 */
export function executorToolset({ instructions = '', tools = [] }) {
  return Object.freeze({
    system: [instructions.trim(), DELEGATION_PROMPT].filter(Boolean).join('\n\n'),
    tools: [
      ...tools.map(tool => ({ name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema ?? { type: 'object', properties: {} } })),
    ],
  });
}

/** MCP 工具结果内容 → Anthropic tool_result 内容块（原样，不截断）。 */
export function toAnthropicContent(content = []) {
  const blocks = [];
  for (const part of content) {
    if (part?.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part?.type === 'image' && part.data) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mimeType || 'image/png', data: part.data } });
    } else if (part?.type) {
      blocks.push({ type: 'text', text: `[${part.type} 内容未转发]` });
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '(无输出)' }];
}

// 回传给模型的助手内容：去掉空文字块（Anthropic 拒绝空文字），其余原样保留。
function assistantContent(content = []) {
  return content.filter(block => block && (block.type !== 'text' || block.text));
}

function textOf(content = []) {
  return content.filter(block => block?.type === 'text' && block.text).map(block => block.text).join('\n').trim();
}

function summarize(content = []) {
  const text = content.find(part => part?.type === 'text' && part.text)?.text ?? '';
  const images = content.filter(part => part?.type === 'image').length;
  const head = text.replace(/\s+/g, ' ').slice(0, 120);
  return `${head}${text.length > 120 ? '…' : ''}${images ? ` [截图×${images}]` : ''}`;
}

function imagesOf(content = []) {
  return content.filter(part => part?.type === 'image' && part.data);
}

/**
 * 报告里引用的截图（#n）→ 证据标签：取引用所在行、编号前面最后一个分句。只认本次存下的编号，
 * 因此 #1F2937 这类颜色值或无关数字不会被当成引用。
 */
export function citedEvidence(text, screenshots) {
  const numbers = new Set(screenshots.map(item => item.number));
  const labels = new Map();
  for (const line of String(text).split('\n')) {
    for (const match of line.matchAll(/#(\d+)(?![\dA-Za-z])/g)) {
      const number = Number(match[1]);
      if (!numbers.has(number) || labels.has(number)) continue;
      const before = line.slice(0, match.index).replace(/[*_`>|]/g, ' ').replace(/^[\s\-•\d.、]+/, '').replace(/[\s:：（(，,、]+$/, '');
      // 只取最后一个分句，去掉“看到的事实：”这类前缀。
      const label = before.split(/[：:。；;，,]/).map(part => part.trim()).filter(Boolean).at(-1) ?? '';
      labels.set(number, label.slice(-30) || `截图 #${number}`);
    }
  }
  return screenshots.map(item => ({ ...item, cited: labels.has(item.number), label: labels.get(item.number) ?? `截图 #${item.number}` }));
}

/** 在对话末尾追加一条用户消息；末尾已是用户消息（上次停在步数上限）时合并进去，保持角色交替。 */
function appendUser(messages, text) {
  const last = messages.at(-1);
  if (last?.role !== 'user') {
    messages.push({ role: 'user', content: text });
    return;
  }
  const blocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
  last.content = [...blocks, { type: 'text', text }];
}

/**
 * 运行一次委托任务，或在 history（上一次返回的 messages）上继续。
 * - createMessage(body, { signal }) 调用网关；execute(name, args, { signal }) 执行一个原生工具并返回 MCP 结果。
 * - onStep 在每次工具调用后被调用，用于向调用方报告进度。
 * 返回值中的 screenshots 是本次 js 返回的全部截图（编号接在 evidenceOffset 之后，标出报告是否引用）；messages 可用于下一次继续。
 */
export async function runDelegatedTask(options) {
  if (!options.model) throw new Error('没有可用的模型：请在调用时传入 model，或用 magpie plugin options magpie-computer-use \'{"model":"provider/model"}\' 设置默认模型。');
  return runWithMessages(options);
}

/**
 * 推理强度 → Messages 请求字段。magpie 会把它换成上游供应商的写法（例如 OpenAI 的 reasoning.effort）；
 * auto 不发送，由模型与供应商的默认值决定。
 */
export function reasoningFields(effort) {
  if (!effort || effort === 'auto') return {};
  return { thinking: { type: 'adaptive' }, output_config: { effort } };
}

// 执行循环。始终用 Anthropic Messages 格式；上游用什么接口（Messages / Chat Completions / Responses）由 magpie 中的供应商设置决定。
async function runWithMessages({
  task, app, model, maxSteps, maxTokens, toolset, createMessage, execute, signal, onStep = () => {},
  history = null, lastImage: previousImage, evidenceOffset = 0, effort,
}) {
  const instruction = app ? `${task}\n\n目标应用：${app}` : task;
  const messages = history ? structuredClone(history) : [];
  if (history) appendUser(messages, `委托方 Agent 的后续指令：\n${instruction}`); else messages.push({ role: 'user', content: instruction });
  const steps = [];
  const screenshots = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let lastImage = previousImage;
  let finalText = '';
  let stopReason;

  for (let turn = 0; ; turn++) {
    signal?.throwIfAborted();
    const response = await createMessage({
      model, max_tokens: maxTokens, system: toolset.system, tools: toolset.tools, messages, ...reasoningFields(effort),
    }, { signal });
    usage.input_tokens += response.usage?.input_tokens ?? 0;
    usage.output_tokens += response.usage?.output_tokens ?? 0;
    usage.cache_read_input_tokens += response.usage?.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens += response.usage?.cache_creation_input_tokens ?? 0;
    const content = assistantContent(response.content);
    stopReason = response.stop_reason;
    const calls = content.filter(block => block.type === 'tool_use');
    if (textOf(content)) finalText = textOf(content);
    if (!calls.length) {
      if (content.length) messages.push({ role: 'assistant', content });
      break;
    }
    if (turn >= maxSteps) {
      stopReason = 'max_steps';
      break;
    }
    messages.push({ role: 'assistant', content });

    const results = [];
    for (const call of calls) {
      signal?.throwIfAborted();
      const input = call.input ?? {};
      const result = await run(call.name, input);
      const step = { tool: call.name, input, isError: Boolean(result.isError), summary: summarize(result.content) };
      steps.push(step);
      await onStep({ ...step, index: steps.length, turn: turn + 1, maxSteps });
      const content = toAnthropicContent(result.content);
      // 截图自动存为证据，结果末尾注明编号，执行模型在报告里引用即可，不必另花一轮。
      const images = imagesOf(result.content);
      if (images.length) {
        const first = evidenceOffset + screenshots.length + 1;
        for (const image of images) screenshots.push({ number: evidenceOffset + screenshots.length + 1, image });
        lastImage = images.at(-1);
        const last = evidenceOffset + screenshots.length;
        content.push({ type: 'text', text: `[MCU] 截图已存为证据 ${first === last ? `#${first}` : `#${first}–#${last}`}，可在报告中引用。` });
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(result.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }

  async function run(name, args) {
    try {
      return await execute(name, args, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  }

  return { model, text: finalText, stopReason, steps, usage, lastImage, screenshots: citedEvidence(finalText, screenshots), messages };
}

const NOTES = {
  max_steps: '已达到步数上限，任务可能未完成。可带上 session_id 再次调用 computer_use 继续。',
  max_tokens: '模型输出达到长度上限，报告可能不完整。',
  refusal: '模型拒绝继续执行。',
};

/**
 * 委托结果 → 返回给调用方 Agent 的 MCP 内容。
 * evidence：本次 js 返回的全部截图 [{ number, label, cited, image, file }]。列出并附上报告引用的那些
 * （没有引用时取最后一张作为最终画面）；maxImages：最多随结果附上的原图张数（取最后几张），其余只给文件路径。
 * session：继续用的会话编号。
 */
export function formatDelegatedResult(result, { includeScreenshot = false, evidence = [], maxImages = 0, sessionId = null } = {}) {
  const lines = [result.text || '（模型没有给出文字报告）'];
  if (NOTES[result.stopReason]) lines.push('', `⚠ ${NOTES[result.stopReason]}`);
  // 运行时拒绝未授权的应用时，告诉调用方如何授权（需要用户本人在终端确认）。
  const unapproved = [...new Set(result.steps.map(step => /not approved to use (.+?)(?:…|$)/.exec(step.summary)?.[1]).filter(Boolean))];
  if (unapproved.length) {
    lines.push('', `提示：${unapproved.join('、')} 尚未授权 Computer Use。请用户在终端运行 ${unapproved.map(name => `lcu apps allow "${name}"`).join('、')}（需要 Touch ID 或密码）后重试。`);
  }

  const cited = evidence.filter(item => item.cited);
  const shown = cited.length ? cited : evidence.slice(-1).map(item => ({ ...item, label: '最终画面' }));
  const inline = maxImages > 0 ? shown.slice(-maxImages) : [];
  if (shown.length) {
    lines.push('', `证据截图（${cited.length ? `报告引用的 ${cited.length} 张` : '报告没有引用截图，这是最后一张'}，原始画面；对比、美观、对错请你自己看图判断）：`);
    for (const item of shown) {
      const attached = inline.includes(item) ? '已附在下方' : '未附原图，需要时用 Read 打开文件';
      lines.push(`#${item.number} ${item.label}（${attached}${item.file ? `；${item.file}` : ''}）`);
    }
    const folder = evidence.find(item => item.file)?.file?.replace(/\/[^/]+$/, '');
    if (folder && evidence.length > shown.length) lines.push(`本次共 ${evidence.length} 张截图，全部保存在 ${folder}`);
  }
  if (sessionId) {
    lines.push('', `session_id：${sessionId}。要让执行模型接着操作（例如“再往下滚”“放大截一张 B 的按钮”），带上它再调用 computer_use；要自己看当前屏幕，用 look。`);
  }

  const failed = result.steps.filter(step => step.isError).length;
  lines.push('', `— 执行模型：${result.model}；工具调用 ${result.steps.length} 次${failed ? `（失败 ${failed} 次）` : ''}；tokens 输入 ${result.usage.input_tokens} / 输出 ${result.usage.output_tokens}${result.usage.cache_read_input_tokens ? ` / 缓存读取 ${result.usage.cache_read_input_tokens}` : ''}`);
  if (result.steps.length) {
    lines.push('步骤：');
    result.steps.forEach((step, index) => {
      const target = step.input.app ? ` ${step.input.app}` : step.input.title ? ` ${step.input.title}` : '';
      lines.push(`${index + 1}. ${step.tool}${target}${step.isError ? ' ✘' : ''} — ${step.summary}`);
    });
  }
  const content = [{ type: 'text', text: lines.join('\n') }];
  for (const item of inline) {
    content.push({ type: 'text', text: `证据 #${item.number}：${item.label}` }, item.image);
  }
  if (includeScreenshot && result.lastImage && !inline.some(item => item.image === result.lastImage)) {
    content.push({ type: 'text', text: '最后一张截图：' }, result.lastImage);
  }
  return { content, ...(result.stopReason === 'max_steps' && !result.text ? { isError: true } : {}) };
}
