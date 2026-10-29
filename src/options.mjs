/**
 * 插件选项：用户通过 `magpie plugin options magpie-computer-use '{"model":"…"}'`（或 magpie 插件列表中的
 * 选项编辑器）设置，保存在 plugins.json 中本插件的条目里。MCP 进程每次需要时重新读取，修改无需重连。
 */
import { defaultMagpieConfigDirectory } from './config.mjs';
import { findPluginEntry } from './plugin-entry.mjs';

export const TOOL_MODES = ['delegate', 'direct', 'both'];
// 应用授权方式：manual 弹出询问（选项摊开）；agent 跟随 Agent 的权限模式；auto 不询问、直接允许。
export const APPROVAL_MODES = ['manual', 'agent', 'auto'];
// Agent 直接操作时拿到的工具：original 为 ChatGPT 原版 js / js_reset；wrapped 为插件包装的十个单步工具。
export const DIRECT_MODES = ['original', 'wrapped'];
// 执行模型的推理强度；auto 不指定，由模型与供应商的默认值决定。
export const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
// 早期版本的取值，读取时换成最接近的级别。
const LEGACY_EFFORTS = { none: 'low', minimal: 'low' };
// 委托由谁执行：api 为 MCU 自己调用执行模型；codex 为交给 Codex（官方 Harness 与官方 Computer Use 插件）。
export const DELEGATE_VIA = ['api', 'codex'];

export const DEFAULT_OPTIONS = Object.freeze({
  // 执行 computer_use 任务的模型（magpie 中的 provider/model，例如 relay-anthropic/claude-sonnet-5-5）。
  model: null,
  // 对 Agent 暴露哪些工具：delegate 只暴露委托工具，direct 只暴露十个操作工具，both 两者都暴露。
  tools: 'both',
  // Agent 直接操作时拿到的工具，见 DIRECT_MODES。
  direct: 'original',
  delegateVia: 'api',
  // Codex 程序路径；不设时用 ChatGPT 应用自带的 Codex，没有则用 PATH 中的 codex。
  codexPath: null,
  // 执行模型的推理强度，见 EFFORTS。
  executorEffort: 'medium',
  // 应用授权方式，见 APPROVAL_MODES。
  approval: 'manual',
  // 使用 Chrome 扩展操作网页：开启后以 lcu --chrome 启动运行时，执行模型与 Agent 可用 ChatGPT 原版的浏览器 API。
  chrome: false,
  // 一次委托任务最多执行的工具调用轮数。
  maxSteps: 40,
  // 委托结果中最多附上几张证据原图给调用方 Agent（其余只给文件路径）；0 表示只给路径。
  evidenceImages: 4,
  // 执行模型每轮回复的最大输出 token（包括推理）。
  maxTokens: 32000,
  // magpie 本机网关；Claude Code 等 Agent 也是经它访问模型。
  gatewayUrl: 'http://127.0.0.1:3425',
  gatewayKey: 'magpie',
});

const fail = message => { throw new Error(`插件选项无效：${message}`); };

function integerIn(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name} 应为 ${min}–${max} 的整数`);
  return value;
}

/** 校验并补全选项。未知字段忽略（便于以后扩展），已知字段类型不对时报错，避免静默使用错误配置。 */
export function normalizeOptions(raw = {}, env = process.env) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const options = { ...DEFAULT_OPTIONS };
  if (input.model !== undefined && input.model !== null && input.model !== '') {
    if (typeof input.model !== 'string' || !input.model.trim()) fail('model 应为模型名称字符串');
    options.model = input.model.trim();
  }
  if (input.tools !== undefined) {
    if (!TOOL_MODES.includes(input.tools)) fail(`tools 应为 ${TOOL_MODES.join(' / ')} 之一`);
    options.tools = input.tools;
  }
  if (input.direct !== undefined) {
    if (!DIRECT_MODES.includes(input.direct)) fail(`direct 应为 ${DIRECT_MODES.join(' / ')} 之一`);
    options.direct = input.direct;
  }
  if (input.delegateVia !== undefined) {
    if (!DELEGATE_VIA.includes(input.delegateVia)) fail(`delegateVia 应为 ${DELEGATE_VIA.join(' / ')} 之一`);
    options.delegateVia = input.delegateVia;
  }
  if (input.codexPath !== undefined && input.codexPath !== null) {
    if (typeof input.codexPath !== 'string' || !input.codexPath.trim()) fail('codexPath 应为 Codex 程序路径');
    options.codexPath = input.codexPath.trim();
  }
  if (input.executorEffort !== undefined) {
    const effort = LEGACY_EFFORTS[input.executorEffort] ?? input.executorEffort;
    if (!EFFORTS.includes(effort)) fail(`executorEffort 应为 ${EFFORTS.join(' / ')} 之一`);
    options.executorEffort = effort;
  }
  if (input.approval !== undefined) {
    if (!APPROVAL_MODES.includes(input.approval)) fail(`approval 应为 ${APPROVAL_MODES.join(' / ')} 之一`);
    options.approval = input.approval;
  }
  if (input.chrome !== undefined) {
    if (typeof input.chrome !== 'boolean') fail('chrome 应为 true 或 false');
    options.chrome = input.chrome;
  }
  if (input.maxSteps !== undefined) options.maxSteps = integerIn(input.maxSteps, 'maxSteps', 1, 200);
  if (input.evidenceImages !== undefined) options.evidenceImages = integerIn(input.evidenceImages, 'evidenceImages', 0, 10);
  if (input.maxTokens !== undefined) options.maxTokens = integerIn(input.maxTokens, 'maxTokens', 256, 64000);
  if (input.gatewayUrl !== undefined) {
    let url;
    try { url = new URL(input.gatewayUrl); } catch { fail('gatewayUrl 应为 http(s) 地址'); }
    if (!['http:', 'https:'].includes(url.protocol)) fail('gatewayUrl 应为 http(s) 地址');
    options.gatewayUrl = input.gatewayUrl.replace(/\/+$/, '');
  }
  if (input.gatewayKey !== undefined) {
    if (typeof input.gatewayKey !== 'string' || !input.gatewayKey) fail('gatewayKey 应为非空字符串');
    options.gatewayKey = input.gatewayKey;
  }
  // 环境变量用于临时覆盖（例如在终端里调试），优先于 magpie 中保存的选项。
  if (env.MAGPIE_CU_MODEL) options.model = env.MAGPIE_CU_MODEL;
  if (env.MAGPIE_CU_GATEWAY) options.gatewayUrl = env.MAGPIE_CU_GATEWAY.replace(/\/+$/, '');
  return options;
}

/** 读取 magpie 中为本插件保存的选项；插件未经 magpie 安装（例如直接运行）时使用默认值。 */
export async function readPluginOptions({ directory = defaultMagpieConfigDirectory(), env = process.env, find = findPluginEntry } = {}) {
  const entry = await find(directory);
  return normalizeOptions(entry?.options ?? {}, env);
}
