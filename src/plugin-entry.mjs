/**
 * 在 magpie 的安装记录（plugins.json）中找到本插件自己的条目。卸载监视用它判断插件是否仍安装；
 * MCP 进程用它读取用户在 magpie 中为本插件设置的选项（`magpie plugin options magpie-computer-use …`）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_NAME, PROJECT_ROOT } from './config.mjs';

export async function canonical(file) {
  try { return await fs.realpath(file); } catch { return path.resolve(file); }
}

/** 返回安装列表；缺失、半写入或结构不对时返回 null（表示“未知”，不能据此删除任何东西）。 */
export async function registry(directory) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory, 'plugins.json'), 'utf8'));
    if (!Array.isArray(value?.plugins) || value.plugins.some(entry => !entry || typeof entry.spec !== 'string' || !entry.spec)) return null;
    return value.plugins;
  } catch { return null; }
}

function npmSpec(spec) {
  return spec === PLUGIN_NAME || spec.startsWith(`${PLUGIN_NAME}@`) && spec.length > PLUGIN_NAME.length + 1;
}

/** 某个安装规格是否指向 root 这份安装。 */
export async function targetsOwner(spec, directory, root) {
  if (npmSpec(spec)) return await canonical(path.join(directory, 'plugins/node_modules', PLUGIN_NAME)) === root;
  if (spec.startsWith('file://') || path.isAbsolute(spec)) {
    let target;
    try { target = spec.startsWith('file://') ? fileURLToPath(spec) : spec; } catch { return false; }
    target = await canonical(target);
    return target === root || target === path.join(root, 'index.mjs');
  }
  // Git 规格的包名由 magpie 安装时记录；不能仅凭仓库名中含 computer-use 就认领。
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'plugins/package.json'), 'utf8'));
    return manifest.dependencies?.[PLUGIN_NAME] === spec &&
      await canonical(path.join(directory, 'plugins/node_modules', PLUGIN_NAME)) === root;
  } catch { return false; }
}

/** 本插件在安装列表中的条目（含 off 与 options 字段），找不到时返回 null。 */
export async function findPluginEntry(directory, root = PROJECT_ROOT) {
  const entries = await registry(directory);
  if (!entries) return null;
  root = await canonical(root);
  for (const entry of entries) {
    if (await targetsOwner(entry.spec, directory, root)) return { ...entry, root };
  }
  return null;
}

/** 卸载监视使用的“所有者”标识：安装规格与真实安装目录。 */
export async function findPluginOwner(directory, root = PROJECT_ROOT) {
  const entry = await findPluginEntry(directory, root);
  return entry ? { spec: entry.spec, root: entry.root } : null;
}
