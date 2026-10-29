/** 常量与路径。插件不保存任何用户选项：LCU 的位置、版本与授权全部在每次 MCP 启动时由本机决定。 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_NAME = 'magpie-computer-use';
export const VERSION = '0.1.0';
export const BIN_PATH = path.join(PROJECT_ROOT, 'bin/magpie-computer-use.mjs');

// 插件使用的共享客户端接口（createCuaClient、call、turnEnded、close）自 0.11.4 起稳定。
export const MIN_LCU_VERSION = '0.11.4';
// 本插件实际联调过的 LCU 版本；其他版本仍会尝试使用，诊断时只做提示。
export const TESTED_LCU_VERSION = '0.13.2';

/** magpie 配置目录：与 magpie 自身一致，遵循 XDG_CONFIG_HOME，否则为 ~/.config/magpie。 */
export function defaultMagpieConfigDirectory(env = process.env, home = os.homedir()) {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return path.join(base, 'magpie');
}
