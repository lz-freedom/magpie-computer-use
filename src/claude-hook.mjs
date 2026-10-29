/**
 * 跟随 Agent 的权限模式。MCP 协议不传递 Agent 的权限模式（实测 Claude Code 的 tools/call 只带 progressToken 与
 * toolUseId），但 Claude Code 的 PreToolUse 钩子输入里有 permission_mode 与同一个 tool_use_id。
 * 钩子在每次调用本插件的工具前把模式写进一个小文件；MCP 处理授权询问时按 toolUseId 读出。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BIN_PATH } from './config.mjs';

export const MODES_DIRECTORY = path.join(os.tmpdir(), 'magpie-computer-use-modes');
// 只匹配本插件的工具（资源库中的 MCP 名为 magpie-computer-use）。
export const HOOK_MATCHER = 'mcp__magpie-computer-use__.*';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Claude Code 的权限模式 → 应用授权的处理方式：allow 直接允许，ask 询问，decline 拒绝。 */
export function decisionFor(mode) {
  if (mode === 'bypassPermissions' || mode === 'auto') return 'allow';
  if (mode === 'plan' || mode === 'dontAsk') return 'decline';
  return 'ask';
}

/** 钩子入口：读取 Claude Code 传来的 JSON，记下这次工具调用的权限模式。总是静默退出，不影响 Claude Code 的判断。 */
export async function recordHookInput(text, { directory = MODES_DIRECTORY, now = Date.now } = {}) {
  let input;
  try { input = JSON.parse(text); } catch { return false; }
  const id = input?.tool_use_id;
  const mode = input?.permission_mode;
  if (typeof id !== 'string' || !SAFE_ID.test(id) || typeof mode !== 'string' || !mode) return false;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ mode, session: input.session_id ?? null, at: now() }), { mode: 0o600 });
  // 顺便清理一天前的记录
  for (const name of await fs.readdir(directory).catch(() => [])) {
    const file = path.join(directory, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && now() - stat.mtimeMs > MAX_AGE_MS) await fs.rm(file, { force: true });
  }
  return true;
}

/** 按 toolUseId 读出钩子记录的权限模式；没有记录时返回 null。 */
export async function readMode(toolUseId, { directory = MODES_DIRECTORY } = {}) {
  if (typeof toolUseId !== 'string' || !SAFE_ID.test(toolUseId)) return null;
  try {
    const record = JSON.parse(await fs.readFile(path.join(directory, `${toolUseId}.json`), 'utf8'));
    return typeof record?.mode === 'string' ? record.mode : null;
  } catch {
    return null;
  }
}

/** Claude Code 的用户设置文件（遵循 CLAUDE_CONFIG_DIR）。 */
export function claudeSettingsPath(env = process.env, home = os.homedir()) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
}

export function hookCommand(launcher = process.execPath, entry = BIN_PATH) {
  return `"${launcher}" "${entry}" claude-hook`;
}

const isOurs = hook => typeof hook?.command === 'string' && hook.command.includes(path.basename(BIN_PATH)) && hook.command.endsWith(' claude-hook');

/** 在 Claude Code 设置中加入（或更新）本插件的 PreToolUse 钩子；只改动本插件自己的条目。返回是否有改动。 */
export async function installClaudeHook({ file = claudeSettingsPath(), command = hookCommand() } = {}) {
  let settings = {};
  try {
    settings = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取 Claude Code 设置 ${file}：${error.message}`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`Claude Code 设置 ${file} 不是 JSON 对象`);
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const groups = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const existing = groups.find(group => group?.matcher === HOOK_MATCHER && Array.isArray(group.hooks) && group.hooks.some(isOurs));
  if (existing?.hooks.some(hook => isOurs(hook) && hook.command === command)) return false;
  const others = groups
    .map(group => (Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter(hook => !isOurs(hook)) } : group))
    .filter(group => !Array.isArray(group?.hooks) || group.hooks.length);
  others.push({ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command, timeout: 5 }] });
  settings.hooks = { ...hooks, PreToolUse: others };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  await fs.rename(temporary, file);
  return true;
}

/** 移除本插件的钩子，保留其他钩子。返回是否有改动。 */
export async function uninstallClaudeHook({ file = claudeSettingsPath() } = {}) {
  let settings;
  try { settings = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return false; }
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups) || !groups.some(group => Array.isArray(group?.hooks) && group.hooks.some(isOurs))) return false;
  const kept = groups
    .map(group => (Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter(hook => !isOurs(hook)) } : group))
    .filter(group => !Array.isArray(group?.hooks) || group.hooks.length);
  if (kept.length) settings.hooks.PreToolUse = kept; else delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  await fs.rename(temporary, file);
  return true;
}
