/**
 * 应用授权请求。原始运行时第一次操作某个应用时，发出一个空表单的 MCP elicitation，把可选的授权范围放在
 * `_meta.persist`（例如 session、always）中；回答时用 `_meta.persist` 告诉它记住多久。客户端（例如 Claude Code）
 * 只会把空表单显示为“接受/拒绝”，接受时不带 `_meta.persist`，运行时便当作“仅此一次”，于是每一步都重新询问。
 *
 * 插件选项 approval 决定怎么处理：
 * - manual：改写成带勾选框的表单（Claude Code 会把单选折叠起来，勾选框则逐项直接显示）。
 * - agent：跟随 Agent 的权限模式（由 Claude Code 钩子记录，见 claude-hook.mjs）：允许、询问或拒绝。
 * - auto：不询问，直接按本次会话允许。只在开着这个设置时生效，不写入永久授权名单。
 */

export const APPROVAL_LABELS = Object.freeze({
  manual: '手动授权',
  agent: '跟随 Agent 权限模式',
  auto: '所有应用直接允许',
});

/** 是否为原始运行时的应用授权请求；是则返回应用与运行时提供的授权范围，否则返回 undefined。 */
export function appApproval(params) {
  const meta = params?._meta;
  const schema = params?.requestedSchema;
  const properties = schema?.properties;
  const app = meta?.tool_params?.app;
  const emptyForm = schema?.type === 'object' && properties && typeof properties === 'object' && !Array.isArray(properties) &&
    Object.keys(properties).length === 0 && (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0));
  if ((params?.mode ?? 'form') !== 'form' || typeof params?.message !== 'string' || !params.message || !emptyForm ||
      meta?.connector_id !== 'computer-use' || typeof app !== 'string' || !app) {
    return undefined;
  }
  const offered = new Set(Array.isArray(meta.persist) ? meta.persist : []);
  return { app, message: params.message, session: offered.has('session'), always: offered.has('always') };
}

/** 手动授权的表单：保留原始提示，授权范围用勾选框逐项列出（默认勾选“本次会话内不再询问”）。 */
export function approvalForm(params, approval) {
  const properties = {};
  if (approval.session) {
    properties.session = { type: 'boolean', title: '本次会话内不再询问这个应用', default: true };
  }
  if (approval.always) {
    properties.always = { type: 'boolean', title: '以后始终允许（等同 lcu apps allow，可用 lcu apps revoke 撤销）', default: false };
  }
  const hint = Object.keys(properties).length
    ? '勾选授权范围后选 Accept；都不勾只允许这一次。选 Decline 拒绝。'
    : '选 Accept 允许这一次，选 Decline 拒绝。';
  return { ...params, mode: 'form', message: `${approval.message}\n${hint}`, requestedSchema: { type: 'object', properties } };
}

const persist = scope => ({ action: 'accept', content: {}, _meta: { persist: scope } });
const once = () => ({ action: 'accept', content: {} });

/** 手动授权：勾选结果 → 运行时的回答。“始终”优先；客户端只回接受不带内容时按默认（本次会话）处理。 */
export function approvalAnswer(approval, answer) {
  if (answer?.action === 'decline') return { action: 'decline' };
  if (answer?.action !== 'accept') return { action: 'cancel' };
  const content = answer.content ?? {};
  if (approval.always && content.always === true) return persist('always');
  if (approval.session && content.session !== false) return persist('session');
  return once();
}

/** 跟随 Agent 与直接允许：接受即本次会话内不再询问（运行时不提供会话范围时只能允许这一次）。 */
/** 浏览器网站访问授权（access_browser_origin）：返回要访问的源，不是这类请求时返回 null。 */
export function browserOrigin(params) {
  const meta = params?._meta ?? params?.meta;
  if (meta?.tool_name !== 'access_browser_origin' || typeof meta.origin !== 'string') return null;
  try {
    const url = new URL(meta.origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === meta.origin ? url.origin : null;
  } catch {
    return null;
  }
}

export function sessionAnswer(approval, answer = { action: 'accept' }) {
  if (answer?.action === 'decline') return { action: 'decline' };
  if (answer?.action !== 'accept') return { action: 'cancel' };
  return approval.session ? persist('session') : once();
}
