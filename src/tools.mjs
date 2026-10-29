/**
 * 十个 Computer Use 工具：对 Agent 暴露稳定的参数协议，并把每次调用翻译为 LCU 运行时 `js` 工具的代码。
 * 生成的代码只含固定模板和经 JSON 编码的数据；用户输入不会被当作代码拼接。
 * 运行时 API 以 LCU 0.13.2 随应用返回的说明为准（await cua.getState() 的首次调用指南）。
 */
import { createHash } from 'node:crypto';

// 十个原生 Computer Use 操作的公开协议。
const app = { type: 'string', minLength: 1, description: '应用名称、绝对 .app 路径或明确的 bundle identifier。' };
const index = { type: 'string', pattern: '^[0-9]+$', description: '最近一次界面状态中的元素索引。' };
const text = { type: 'string' };
const number = { type: 'number' };
const object = (properties, required = []) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
const tool = (name, description, properties, required) => ({ name, description, inputSchema: object(properties, required) });

export const NATIVE_TOOLS = [
  tool('list_apps', '列出本机运行或近期使用过的应用。', {}),
  tool('get_app_state', '选择应用并按原始流程请求授权，返回其当前窗口的界面树和截图。操作应用前先调用；需要新截图时再次调用。', { app }, ['app']),
  tool('click', '按最新界面的元素索引或截图坐标点击，并返回更新后的界面状态。', { app, element_index: index, x: number, y: number, click_count: { type: 'integer', minimum: 1 }, mouse_button: { type: 'string', enum: ['left', 'right', 'middle'] } }, ['app']),
  tool('perform_secondary_action', '执行最新界面树中该元素明确提供的辅助操作，并返回更新状态。', { app, element_index: index, action: { ...text, minLength: 1 } }, ['app', 'element_index', 'action']),
  tool('set_value', '设置可编辑界面元素的值，并返回更新状态。', { app, element_index: index, value: text }, ['app', 'element_index', 'value']),
  tool('select_text', '选中界面中的文字，或把光标放到文字前后；重复文字可用 prefix/suffix 消歧。', { app, element_index: index, text, prefix: text, suffix: text, selection: { type: 'string', enum: ['text', 'cursor_before', 'cursor_after'] } }, ['app', 'element_index', 'text']),
  tool('scroll', '对界面元素按方向滚动指定页数，并返回更新状态。', { app, element_index: index, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, pages: { type: 'number', exclusiveMinimum: 0 } }, ['app', 'element_index', 'direction']),
  tool('drag', '按截图像素坐标拖动，并返回更新状态。', { app, from_x: number, from_y: number, to_x: number, to_y: number }, ['app', 'from_x', 'from_y', 'to_x', 'to_y']),
  tool('press_key', '发送按键或组合键，例如 Return、Tab、super+c，并返回更新状态。', { app, key: { ...text, minLength: 1 } }, ['app', 'key']),
  tool('type_text', '向应用输入原样文字，并返回更新状态。', { app, text }, ['app', 'text']),
];

export const NATIVE_TOOL_NAMES = new Set(NATIVE_TOOLS.map(definition => definition.name));

// 委托工具：把任务交给指定模型执行（手和眼），返回事实报告与证据截图，判断留给调用方 Agent。
export const DELEGATE_TOOLS = [
  tool('computer_use', '（简称 mcu，即 magpie computer use：用户说“用 mcu …”时调用此工具。）把电脑操作交给插件设置的执行模型在本机完成（读取界面、点击、输入等）。它只负责操作和陈述事实，返回：事实报告、报告引用的证据截图（报告里以 #n 标注，全部截图另存为文件）、以及 session_id。需要判断的事（哪个更好、UI 是否美观、结果对不对）请你自己看证据截图下结论，不要只采信报告。要它接着操作，带上 session_id 再调用并写下一步指令；要自己看当前屏幕用 look。涉及发送、提交、删除、购买等操作时请在任务中明确说明。', {
    task: { ...text, minLength: 1, description: '要完成的任务或后续指令。写明目标、需要截图给你看的画面（例如“A、B 两个页面各截一张首页”）和完成标准。' },
    app: { ...text, minLength: 1, description: '可选：目标应用名称或 bundle identifier。' },
    session_id: { ...text, minLength: 1, description: '可选：上一次 computer_use 返回的 session_id。带上它时执行模型保留之前的操作与画面，接着执行 task。' },
    model: { ...text, minLength: 1, description: '可选：执行任务的模型（provider/model），默认使用插件选项中的 model。可用 list_computer_use_models 查看。' },
    max_steps: { type: 'integer', minimum: 1, maximum: 200, description: '可选：本次最多工具调用轮数，默认使用插件选项中的 maxSteps。' },
    max_images: { type: 'integer', minimum: 0, maximum: 10, description: '可选：最多随结果附上几张证据原图（取最后几张），默认使用插件选项 evidenceImages；其余证据只给文件路径。' },
    include_screenshot: { type: 'boolean', description: '可选：另外附上执行结束时的最后一张截图，默认不附。' },
  }, ['task']),
  tool('look', '只看一眼：返回某个应用当前窗口的截图，不做任何操作。用来核实 computer_use 的报告，或在委托之间自己判断界面。', { app }, ['app']),
  tool('list_computer_use_models', '列出 magpie 中可以执行 computer_use 的模型（能接收截图并调用工具），并标出当前默认模型。', {}),
];

export const DELEGATE_TOOL_NAMES = new Set(DELEGATE_TOOLS.map(definition => definition.name));

export const DELEGATE_INSTRUCTIONS = 'Use computer_use (the user may call it "mcu", short for magpie computer use) to have a dedicated model operate desktop apps for you. It is your hands and eyes, not your judge: it returns a factual report, the screenshots it cites as evidence (all its screenshots are saved to files), and a session_id. Make comparisons and quality judgments yourself from the screenshots. Pass session_id with a follow-up task to keep steering the same session, and use look to see an app\'s current screen without acting. Ask in the task for the screens you want to see. Use list_computer_use_models to see which models can run it.';

export const NATIVE_INSTRUCTIONS = 'This MCP exposes ten native Computer Use operations. Use list_apps to discover apps, then get_app_state to request access and obtain the current screenshot and accessibility indices before interacting. Each action returns updated accessibility state; call get_app_state for a fresh screenshot. The underlying runtime\'s documentation may refer to JavaScript/cua_repl; these tools already wrap that API, so call the named native tools directly. App authorization remains the original user\'s decision. Contexts are isolated by MCP connection unless the host supplies actual turn metadata.';

const fail = message => { throw new Error(message); };

// element_index 在协议中是数字字符串；Agent 也可能直接发送整数，两者都接受并归一为整数。
function elementIndex(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  return fail('element_index must be a valid element index');
}

function checkValue(field, rule, value) {
  if (rule.type === 'string') {
    if (typeof value !== 'string') fail(`${field} must be a string`);
    if (rule.minLength && value.trim().length < rule.minLength) fail(`${field} must be a nonempty string`);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) fail(`${field} does not match ${rule.pattern}`);
  } else if (rule.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field} must be a finite number`);
    if (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum) fail(`${field} must be greater than ${rule.exclusiveMinimum}`);
  } else if (rule.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity)) {
      fail(`${field} must be an integer${rule.maximum ? ` between ${rule.minimum} and ${rule.maximum}` : ` of at least ${rule.minimum}`}`);
    }
  } else if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') fail(`${field} must be a boolean`);
  }
  if (rule.enum && !rule.enum.includes(value)) fail(`Invalid ${field}: ${JSON.stringify(value)}`);
  return value;
}

/** 按工具定义检查参数：拒绝未知字段、缺失字段与不完整坐标，返回归一化后的参数。 */
export function validateArguments(name, args, definitions = [...NATIVE_TOOLS, ...DELEGATE_TOOLS]) {
  const definition = definitions.find(item => item.name === name);
  if (!definition) fail(`Unknown native Computer Use tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('Tool arguments must be an object');
  const schema = definition.inputSchema;
  for (const field of schema.required ?? []) if (args[field] === undefined) fail(`Missing ${field}`);
  const normalized = {};
  for (const [field, value] of Object.entries(args)) {
    const rule = schema.properties[field];
    if (!rule) fail(`Unknown argument: ${field}`);
    if (value === undefined) continue;
    normalized[field] = field === 'element_index' ? elementIndex(value) : checkValue(field, rule, value);
  }
  if (name === 'click') {
    const byIndex = normalized.element_index !== undefined;
    const byPoint = normalized.x !== undefined || normalized.y !== undefined;
    if (byIndex && byPoint) fail('click accepts an element index or coordinates, not both');
    if (!byIndex && (normalized.x === undefined || normalized.y === undefined)) fail('click requires element_index or both x and y');
  }
  return normalized;
}

/** 同一连接或同一宿主轮次内、同一应用名称对应同一个运行时绑定，避免复用其他上下文的元素索引。 */
export function bindingName(sessionId, turnId, appName) {
  const digest = createHash('sha256').update(JSON.stringify([sessionId, turnId, appName])).digest('hex');
  return `__magpieNative_${digest.slice(0, 32)}`;
}

// 每个动作对应运行时 App/Target 的一个方法（见 cua_repl 说明中的类型定义）。返回不带 await 的调用表达式。
function actionCall(name, args) {
  const json = JSON.stringify;
  const index = String(args.element_index);
  switch (name) {
    case 'click': {
      const where = args.element_index !== undefined ? index : json([args.x, args.y]);
      return `click(${where}, ${json({ clickCount: args.click_count ?? 1, mouseButton: args.mouse_button ?? 'left' })})`;
    }
    case 'perform_secondary_action':
      return `performSecondaryAction(${index}, ${json(args.action)})`;
    case 'set_value':
      return `setValue(${index}, ${json(args.value)})`;
    case 'select_text':
      return `selectText(${index}, ${json(args.text)}, ${json({ prefix: args.prefix, suffix: args.suffix, selectionType: args.selection ?? 'text' })})`;
    case 'scroll':
      return `scroll(${index}, ${json(args.direction)}, ${json(args.pages ?? 1)})`;
    case 'drag':
      return `drag(${json([args.from_x, args.from_y])}, ${json([args.to_x, args.to_y])})`;
    case 'press_key':
      return `pressKey(${json(args.key)})`;
    case 'type_text':
      return `typeText(${json(args.text)})`;
    default:
      return fail(`Unknown native Computer Use tool: ${name}`);
  }
}

/**
 * 把一次工具调用翻译为若干次 `js` 调用（按顺序执行，前一次失败则停止）。
 * 代码与官方 LCU 测试的写法一致：顶层语句，最后一条表达式的结果即返回内容（界面状态或截图）。
 * list_apps 使用运行时指定的首次调用 `cua.getState()`；get_app_state 拆成“选择应用”和“截图”两次调用，
 * 首次调用只包含一个 API，符合运行时说明。
 */
export function buildSteps(name, args, { sessionId, turnId } = {}) {
  const title = name === 'list_apps' ? '列出应用' : name;
  if (name === 'list_apps') return [{ code: 'await cua.getState();', title }];
  if (!sessionId || !turnId) fail('Native operations require the current connection context');
  const binding = bindingName(sessionId, turnId, args.app);
  const bound = `if (typeof ${binding} === 'undefined') throw new Error('Call get_app_state for this app in the current context before interacting');`;
  if (name === 'get_app_state') {
    return [
      // 第一步只选择应用并保存绑定；运行时会把该应用的初始界面状态放入结果。
      { code: `var ${binding} = await cua.getApp(${JSON.stringify(args.app)});`, title },
      // 第二步单独截图，图片作为结果内容返回。
      { code: `${bound}\nawait ${binding}.getScreenshot();`, title },
    ];
  }
  // 动作完成后读取界面树，作为本次调用的结果返回。
  return [{
    code: `${bound}\nawait ${binding}.${actionCall(name, args)};\nawait ${binding}.getAXState();`,
    title,
  }];
}
