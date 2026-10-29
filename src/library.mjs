/**
 * magpie 资源库登记：保存的是 MCP 的启动命令，不是正在运行的 Computer Use 服务。
 * ensureLibraryMcp() 可重复调用：同名且指向本插件的条目保持原样；路径变化时（例如改由本地副本安装）
 * 重新登记并保留原有 Agent 选择；同名的其他 MCP 不会被覆盖。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { BIN_PATH, PLUGIN_NAME } from './config.mjs';
import { run } from './process.mjs';

export async function locateMagpie() {
  const candidates = [
    '/Applications/magpie.app/Contents/MacOS/magpie',
    path.join(process.env.HOMEBREW_PREFIX || '/opt/homebrew', 'bin/magpie'),
  ];
  for (const candidate of candidates) {
    try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  throw new Error('找不到 magpie 可执行文件，无法将 Computer Use 加入资源库。');
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} 必须是有效的绝对路径。`);
  }
  return path.resolve(value);
}

/** 资源库中的 MCP 定义：launcher 运行本包入口的 `mcp` 子命令，命令路径由 magpie 启动时使用。 */
export function libraryMcpDefinition(launcher = process.execPath, entry = BIN_PATH) {
  return {
    name: PLUGIN_NAME,
    transport: 'stdio',
    command: absolutePath(launcher, 'MCP 启动程序'),
    args: [absolutePath(entry, 'MCP 入口'), 'mcp'],
    // 首次登记不替用户选择 Agent；之后由 magpie 资源库分发。
    agents: [],
  };
}

/**
 * 读取资源库。magpie 在资源库没有 MCP 条目时写入 null（空列表），与缺省等价；
 * 只有结构确实不对（根不是对象，或 mcp 既不是数组也不是 null）才报错。
 */
export async function readLibrary(directory) {
  const file = path.join(directory, 'library.json');
  let value;
  try {
    value = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { mcp: [] };
    throw new Error(`无法读取 magpie 资源库：${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value.mcp != null && !Array.isArray(value.mcp))) {
    throw new Error('无法读取 magpie 资源库：资源库应为对象，mcp 应为数组');
  }
  return { ...value, mcp: value.mcp ?? [] };
}

/** 资源库里本插件的条目（按名称认领）。 */
export function ownEntry(library) {
  return library.mcp?.find(entry => entry?.name === PLUGIN_NAME);
}

/** 指向某个 magpie-computer-use 包入口的 `mcp` 条目（不论安装位置与附加参数）；可以安全刷新。 */
export function isOwnEntry(entry) {
  return entry?.transport === 'stdio' && Array.isArray(entry.args) && entry.args.length >= 2 &&
    path.basename(String(entry.args[0])) === path.basename(BIN_PATH) && entry.args[1] === 'mcp';
}

/** 命令与参数都与当前定义一致，才无需改写。 */
export function sameDefinition(entry, definition) {
  return entry?.transport === 'stdio' && entry.command === definition.command &&
    JSON.stringify(entry.args) === JSON.stringify(definition.args);
}

// 沿用宿主的实际配置根，确保官方 CLI 写入同一个用户或隔离测试实例。
function commandEnvironment(directory) {
  const env = { ...process.env };
  if (path.basename(directory) === 'magpie') env.XDG_CONFIG_HOME = path.dirname(directory);
  return env;
}

// 只保留 magpie 可接受的 Agent 名称，避免把异常字段拼进命令行。
function agentList(value) {
  return Array.isArray(value) ? value.filter(name => typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name)) : [];
}

/** 加载扩展时调用：登记或刷新本插件的 MCP，只通过 magpie 自身的资源库命令写入。 */
export async function ensureLibraryMcp(input, _rawOptions, {
  runner = run,
  launcher = process.execPath,
  magpie = locateMagpie,
  entry = BIN_PATH,
} = {}) {
  const directory = absolutePath(input?.directory, 'magpie 配置目录');
  const definition = libraryMcpDefinition(launcher, entry);
  const existing = ownEntry(await readLibrary(directory));
  if (existing && sameDefinition(existing, definition)) return { registered: true, created: false, refreshed: false, definition };
  if (existing && !isOwnEntry(existing)) {
    throw new Error(`magpie 资源库已有同名的其他或自定义 MCP（${PLUGIN_NAME}），插件不会覆盖它；请先在资源库检查或重命名。`);
  }

  const executable = absolutePath(typeof magpie === 'function' ? await magpie() : magpie, 'magpie 启动程序');
  const env = commandEnvironment(directory);
  // 路径变化时先移除旧条目，再以相同的 Agent 选择重新添加；其余 magpie 管理的字段由 magpie 重建。
  const agents = agentList(existing?.agents);
  try {
    if (existing) await runner(executable, ['library', 'mcp', 'rm', PLUGIN_NAME], { cwd: directory, env, timeoutMs: 30_000 });
    await runner(executable, ['library', 'mcp', 'add', PLUGIN_NAME, definition.command, ...definition.args, `agents=${agents.join(',')}`], {
      cwd: directory, env, timeoutMs: 30_000,
    });
  } catch (error) {
    // 多个宿主同时加载时，只接受另一个宿主刚写出的本插件定义。
    const concurrent = ownEntry(await readLibrary(directory));
    if (!sameDefinition(concurrent, definition)) throw error;
    return { registered: true, created: !existing, refreshed: Boolean(existing), definition };
  }
  const added = ownEntry(await readLibrary(directory));
  if (!sameDefinition(added, definition)) throw new Error('magpie 未在当前配置目录登记 Computer Use MCP；请检查插件加载错误。');
  return { registered: true, created: !existing, refreshed: Boolean(existing), definition };
}

/** 卸载时只移除仍指向本包的完全相同的条目；通过 magpie 同步撤销 Agent 配置。 */
export async function removeLibraryMcp(directory, definition, {
  runner = run, magpie = locateMagpie, shouldRemove = async () => true,
} = {}) {
  if (!sameDefinition(ownEntry(await readLibrary(directory)), definition)) return false;
  const executable = absolutePath(typeof magpie === 'function' ? await magpie() : magpie, 'magpie 启动程序');
  // 解析命令可能耗时；实际移除前再核对安装状态和条目归属，避免常见的重新安装竞争。
  if (!await shouldRemove()) return false;
  if (!sameDefinition(ownEntry(await readLibrary(directory)), definition)) return false;
  await runner(executable, ['library', 'mcp', 'rm', PLUGIN_NAME], { cwd: directory, env: commandEnvironment(directory), timeoutMs: 30_000 });
  if (sameDefinition(ownEntry(await readLibrary(directory)), definition)) throw new Error('magpie 未移除本插件的 MCP；稍后重试。');
  return true;
}

/** magpie 在客户端写入失败时仍可能返回 0；账本仍持有本名称时需要继续同步。 */
export function pendingMcpRemoval(library) {
  const hasName = names => Array.isArray(names) && names.includes(PLUGIN_NAME);
  return Object.values(library.applied ?? {}).some(agent => hasName(agent?.mcp)) ||
    (library.projects ?? []).some(project => Object.values(project.wrote ?? {}).some(hasName));
}

export async function syncMcpRemoval(directory, { runner = run, magpie = locateMagpie, shouldSync = async () => true } = {}) {
  const executable = absolutePath(typeof magpie === 'function' ? await magpie() : magpie, 'magpie 启动程序');
  if (!await shouldSync()) return;
  await runner(executable, ['library', 'sync'], { cwd: directory, env: commandEnvironment(directory), timeoutMs: 30_000 });
}
