/**
 * magpie 本机网关客户端。网关对所有模型（Claude、GPT、DeepSeek…）都提供 Anthropic Messages 格式的
 * /v1/messages，并在 /v1/models 中标明每个模型是否接受图片与工具调用；computer use 两者都需要。
 * 上游用哪种接口（Messages / Chat Completions / Responses）由 magpie 中的供应商设置决定，插件不另作选择。
 */
import { VERSION } from './config.mjs';

const REQUEST_TIMEOUT_MS = 300_000;

// magpie 按 User-Agent 第一个“/”前的名字识别调用方，并对已知 Agent 做前缀匹配：以 magpie 开头的名字会被
// 归到 magpie 自己名下。用 MCU 作为名字，路由与用量页面就会单独显示本插件的请求。
export const USER_AGENT = `MCU/${VERSION} (magpie-computer-use)`;

export class GatewayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
  }
}

/** 是否适合 computer use：能接收截图，且能调用工具。网关未声明时视为未知（返回 undefined）。 */
export function supportsComputerUse(model) {
  const inputs = model?.modalities?.input;
  if (!Array.isArray(inputs) && model?.tool_call === undefined) return undefined;
  return Boolean(inputs?.includes('image') && model.tool_call !== false);
}

export function createGatewayClient({ url, key, fetch = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const base = String(url).replace(/\/+$/, '');
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    'anthropic-version': '2023-06-01',
    'user-agent': USER_AGENT,
  };

  async function request(path, { method = 'GET', body, signal } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body), signal: combined });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw new GatewayError(`magpie 网关请求超时（${timeoutMs / 1000} 秒）：${base}${path}`);
      throw new GatewayError(`无法连接 magpie 网关 ${base}：${error.cause?.code ?? error.message}。请确认 magpie 正在运行。`);
    }
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = undefined; }
    if (!response.ok) {
      const detail = data?.error?.message ?? text.slice(0, 500);
      throw new GatewayError(`magpie 网关返回 ${response.status}：${detail}`, response.status);
    }
    if (data === undefined) throw new GatewayError(`magpie 网关返回了无法解析的内容：${text.slice(0, 200)}`, response.status);
    return data;
  }

  return {
    url: base,
    async listModels({ signal } = {}) {
      const data = await request('/v1/models', { signal });
      return Array.isArray(data?.data) ? data.data : [];
    },
    async createMessage(body, { signal } = {}) {
      return request('/v1/messages', { method: 'POST', body, signal });
    },
  };
}

/** 可执行 computer_use 的模型清单（文字），供 list_computer_use_models 工具与 `models` 命令共用。 */
export function formatModelList(models, { url, defaultModel } = {}) {
  const usable = models.filter(model => supportsComputerUse(model) !== false);
  const lines = [`magpie 网关 ${url} 中可执行 computer_use 的模型（能接收截图并调用工具）：`];
  for (const model of usable) {
    const label = model.magpie_label ?? model.display_name ?? '';
    lines.push(`- ${model.id}${label ? `（${label}）` : ''}${model.id === defaultModel ? '  ← 当前默认' : ''}`);
  }
  if (!usable.length) lines.push('（没有找到）');
  lines.push('', defaultModel
    ? `当前默认模型：${defaultModel}`
    : '尚未设置默认模型。可在调用 computer_use 时传入 model，或运行：magpie plugin options magpie-computer-use \'{"model":"provider/model"}\'');
  return lines.join('\n');
}
