/**
 * MCP 指令模板：客户端把它显示为斜杠命令（Claude Code 中为 /mcp__magpie-computer-use__mcu）。
 * 用户输入命令与任务后，客户端取回模板内容发给 AI，由 AI 调用 computer_use（或直接操作工具）完成。
 */

export const MCU_PROMPT = Object.freeze({
  name: 'mcu',
  title: 'mcu：用 Computer Use 完成任务',
  description: '把一个电脑操作任务交给 Computer Use（magpie computer use）执行，例如：在备忘录里新建一条笔记。',
  arguments: [{ name: 'task', description: '要完成的任务，例如：在备忘录里新建一条笔记，标题“明天待办”', required: true }],
});

// Claude Code 把斜杠命令后的文字按空格切开，依次填入声明的参数，多出的词直接丢弃（不支持引号）。
// 为它额外声明一批可选参数接住后续的词，取回模板时再按顺序拼回完整任务；
// 其他客户端（例如 Claude 桌面应用）会为每个参数显示一个输入框，因此只给它们一个 task 参数。
export const OVERFLOW_ARGUMENTS = 63;
const OVERFLOW = /^_(\d+)$/;

export const PROMPTS = [MCU_PROMPT];

/** 某个客户端看到的指令模板列表。 */
export function promptsFor(clientName) {
  if (clientName !== 'claude-code') return PROMPTS;
  const overflow = Array.from({ length: OVERFLOW_ARGUMENTS }, (_, index) => ({
    name: `_${index + 2}`, description: '任务的后续文字（自动拼接，无需填写）', required: false,
  }));
  return [{ ...MCU_PROMPT, arguments: [...MCU_PROMPT.arguments, ...overflow] }];
}

/** 把 task 与按空格切开的后续参数（_2、_3…）按顺序拼回完整任务。 */
export function joinTask(args = {}) {
  const rest = Object.entries(args)
    .map(([key, value]) => [Number(OVERFLOW.exec(key)?.[1]), value])
    .filter(([position, value]) => Number.isInteger(position) && typeof value === 'string' && value)
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value);
  return [typeof args.task === 'string' ? args.task : '', ...rest].join(' ').trim();
}

/** 生成发给 AI 的消息。tools=direct 时没有 computer_use，改为让 AI 用直接操作工具（默认原版 js）自己完成。 */
export function buildPrompt(name, args = {}, { tools = 'both', direct = 'original' } = {}) {
  if (name !== MCU_PROMPT.name) throw new Error(`Unknown prompt: ${name}`);
  const task = joinTask(args);
  if (!task) throw new Error('请在命令后写上要完成的任务，例如：在备忘录里新建一条笔记');
  const directText = direct === 'original'
    ? `请使用 magpie-computer-use 的 js 工具（ChatGPT Computer Use 原版）完成下面的任务，按工具说明与首次调用返回的文档操作，完成后告诉我结果。\n\n任务：${task}`
    : `请使用 magpie-computer-use 的操作工具（先 list_apps，再 get_app_state，然后按需点击、输入等）完成下面的任务，完成后告诉我结果。\n\n任务：${task}`;
  const text = tools === 'direct'
    ? directText
    : `请调用 magpie-computer-use 的 computer_use 工具完成下面的任务：把任务作为 task 参数交给它；涉及对比、外观或需要核对结果时，在 task 里写明要它截图给你看的画面。它只负责操作并陈述事实，需要判断的部分请你根据它返回的证据截图自己下结论；不够时带上 session_id 让它继续，或用 look 自己看一眼。最后告诉我结果和未完成的部分。\n\n任务：${task}`;
  return {
    description: MCU_PROMPT.description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}
