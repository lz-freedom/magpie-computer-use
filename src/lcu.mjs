/**
 * 发现本机已安装的 LCU（https://github.com/amontlabs/lcu）。插件不内置 LCU 代码：每次 MCP 启动时
 * 找到当前安装，校验平台与布局，读取版本，并使用该安装自带的官方共享客户端 adapters/client.mjs。
 * LCU 升级后无需改动插件；布局或版本不满足时给出明确的诊断而不是静默失败。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MIN_LCU_VERSION } from './config.mjs';

// releases/<version>-<hash> 是 LCU 安装器的发布目录命名；能直接读出版本，避免每次启动都执行 --version。
const RELEASE_DIRECTORY = /^(\d+\.\d+\.\d+)(?:-[0-9a-f]+)?$/;
const VERSION_OUTPUT = /^lcu (\d+\.\d+\.\d+)\b/m;

export class LcuNotFoundError extends Error {
  constructor(attempts) {
    super([
      '找不到可用的 LCU。请先安装官方 ChatGPT 桌面应用，再按 https://github.com/amontlabs/lcu 的安装说明安装 LCU（默认位置 ~/.local/share/lcu）。',
      ...attempts.map(attempt => `- ${attempt.source}：${attempt.location}\n  ${attempt.problems.join('；')}`),
    ].join('\n'));
    this.name = 'LcuNotFoundError';
    this.attempts = attempts;
  }
}

/** 比较 x.y.z 形式的版本号，返回负数、0 或正数。 */
export function compareVersions(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

export function isExecutable(file) {
  if (!isFile(file)) return false;
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

/** 在 PATH 中查找可执行文件；只返回路径，不执行。 */
export function findOnPath(name, pathValue = process.env.PATH) {
  for (const directory of String(pathValue ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const file = path.join(directory, name);
    if (isExecutable(file)) return file;
  }
  return undefined;
}

/** 待检查的候选位置，按优先级排列。不做任何合法性判断，判断在 inspectLcuRoot() 中进行。 */
export function candidateRoots({ env = process.env, home = os.homedir(), lookPath = findOnPath } = {}) {
  const candidates = [];
  if (env.MAGPIE_CU_LCU) candidates.push({ source: 'MAGPIE_CU_LCU', location: env.MAGPIE_CU_LCU });
  // 与 LCU 安装器一致：默认安装在 ~/.local/share/lcu，LCU_PREFIX 可改为其他前缀。
  const prefix = env.LCU_PREFIX || path.join(home, '.local/share/lcu');
  candidates.push({ source: env.LCU_PREFIX ? 'LCU_PREFIX' : '默认安装位置', location: path.join(prefix, 'current') });
  const onPath = lookPath('lcu', env.PATH);
  if (onPath) candidates.push({ source: 'PATH 中的 lcu', location: onPath });
  return candidates;
}

/**
 * 把用户给出的位置（安装根目录、current 链接或 bin/lcu 启动器）解析为真实的安装根目录。
 * 所有符号链接先解析，因此 ~/.local/bin/lcu 之类的链接会指向其所在的发布目录。
 */
export async function resolveRoot(location) {
  const real = await fsp.realpath(path.resolve(location));
  if (!(await fsp.stat(real)).isFile()) return real;
  if (path.basename(real) === 'lcu' && path.basename(path.dirname(real)) === 'bin') return path.dirname(path.dirname(real));
  throw new Error(`${real} 不是 LCU 启动器或安装目录`);
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

async function readText(file) {
  try { return (await fsp.readFile(file, 'utf8')).trim(); } catch { return ''; }
}

/** 运行 `lcu --version` 读取版本。输出形如：`lcu 0.13.2 (ChatGPT darwin …; CUA …)`。 */
export function readLauncherVersion(launcher, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(launcher, ['--version'], { timeout: timeoutMs, env: process.env }, (error, stdout) => {
      const match = VERSION_OUTPUT.exec(String(stdout ?? ''));
      if (match) resolve(match[1]);
      else reject(new Error(`无法读取 ${launcher} 的版本${error ? `：${error.message}` : ''}`));
    });
  });
}

/**
 * 校验一个安装根目录。只读取文件，不执行 LCU。返回 { ok, root, source, problems }，
 * 通过时附带启动器、共享客户端、版本与 ChatGPT 应用信息。
 */
export async function inspectLcuRoot(root, { source = '未知来源', versionOf = readLauncherVersion } = {}) {
  const launcher = path.join(root, 'bin/lcu');
  const client = path.join(root, 'adapters/client.mjs');
  const problems = [];
  if (!isExecutable(launcher)) problems.push('缺少可执行的 bin/lcu');
  if (!isFile(client)) problems.push('缺少 adapters/client.mjs（LCU 共享客户端）');
  const installation = await readJson(path.join(root, 'installation.json'));
  if (!installation) {
    problems.push('缺少或无法解析 installation.json');
  } else {
    if (installation.platform !== 'darwin' || installation.architecture !== 'arm64') {
      problems.push(`平台 ${installation.platform ?? '?'}-${installation.architecture ?? '?'} 不受支持，需要 darwin-arm64`);
    }
    if (installation.app && !fs.existsSync(installation.app)) problems.push(`ChatGPT 应用不存在：${installation.app}`);
  }
  const nodePath = await readText(path.join(root, 'node-path'));
  if (!nodePath || !isExecutable(nodePath)) {
    problems.push('node-path 缺失或其中的 Node 不可执行；请修复 ChatGPT 应用后重新安装 LCU');
  }
  if (problems.length) return { ok: false, root, source, problems };

  let version = RELEASE_DIRECTORY.exec(path.basename(root))?.[1];
  if (!version) {
    try { version = await versionOf(launcher); } catch (error) { return { ok: false, root, source, problems: [error.message] }; }
  }
  return {
    ok: true, root, source, launcher, client, version,
    app: installation.app, runtime: installation.runtime, nodePath,
  };
}

/** 依次查找候选位置，返回第一个通过校验的安装；全部失败时抛出 LcuNotFoundError（附带每个位置的原因）。 */
export async function discoverLcu({
  env = process.env, home = os.homedir(), lookPath = findOnPath, versionOf = readLauncherVersion,
} = {}) {
  const attempts = [];
  const seen = new Set();
  for (const candidate of candidateRoots({ env, home, lookPath })) {
    let root;
    try {
      root = await resolveRoot(candidate.location);
    } catch (error) {
      attempts.push({ source: candidate.source, location: candidate.location, problems: [`不可用：${error.message}`] });
      continue;
    }
    if (seen.has(root)) continue;
    seen.add(root);
    const info = await inspectLcuRoot(root, { source: candidate.source, versionOf });
    if (info.ok) return info;
    attempts.push({ source: candidate.source, location: root, problems: info.problems });
  }
  throw new LcuNotFoundError(attempts);
}

/** 版本低于插件要求时拒绝启动，并提示更新方式。 */
export function assertCompatible(info) {
  if (compareVersions(info.version, MIN_LCU_VERSION) < 0) {
    throw new Error(`LCU ${info.version} 低于本插件要求的 ${MIN_LCU_VERSION}；请运行 lcu update 更新后重试。`);
  }
}

/** 从该安装自身的 adapters/client.mjs 载入共享客户端，并检查插件需要的入口存在。 */
export async function loadLcuClient(info) {
  const client = await import(pathToFileURL(info.client).href);
  if (typeof client.createCuaClient !== 'function') {
    throw new Error(`LCU ${info.version} 的共享客户端缺少 createCuaClient；请更新 LCU 或插件。`);
  }
  return client.createCuaClient;
}

/**
 * Chrome 连接器状态（lcu browser status --browser chrome）。connector 为 lcu（指向本 LCU 的中转）、other（指向别处，
 * 例如 ChatGPT 应用自己的原生程序）或 unknown；extension 为 enabled、missing 或 unknown（macOS 可能不允许读取 Chrome 配置）。
 */
export function parseBrowserStatus(text) {
  const line = prefix => String(text).split('\n').find(item => item.startsWith(prefix)) ?? '';
  const connectorLine = line('Chrome connector:');
  const extensionLine = line('Chrome extension:');
  const connector = /configured for this LCU installation/.test(connectorLine) ? 'lcu'
    : /not this LCU installation|lcu browser install|not configured|missing/i.test(connectorLine) ? 'other' : 'unknown';
  const extension = /could not check/i.test(extensionLine) ? 'unknown'
    : /not (installed|found|enabled)|disabled|install or enable/i.test(extensionLine) ? 'missing'
      : /enabled|installed/i.test(extensionLine) ? 'enabled' : 'unknown';
  return { connector, extension, text: String(text).trim() };
}

// status 在查不到扩展时也以非零退出，但输出仍有用，所以只在没有输出时当作失败。
function runLcu(launcher, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(launcher, args, { timeout: timeoutMs, env: process.env }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`;
      if (error && (!output.trim() || args[1] === 'install')) {
        reject(new Error(`${path.basename(launcher)} ${args.join(' ')} 失败：${(output || error.message).trim().split('\n').slice(-3).join(' ')}`));
      } else resolve(output);
    });
  });
}

/** 读取 Chrome 连接器与扩展状态。 */
export async function browserStatus(launcher, { run = runLcu } = {}) {
  return parseBrowserStatus(await run(launcher, ['browser', 'status', '--browser', 'chrome']));
}

/**
 * 确保 Chrome 连接器指向本 LCU：没有指向时运行 lcu browser install（ChatGPT 应用更新后可能改回它自己的原生程序）。
 * 返回最新状态与是否刚安装。
 */
export async function ensureBrowserConnector(launcher, { run = runLcu } = {}) {
  const before = await browserStatus(launcher, { run });
  if (before.connector === 'lcu') return { ...before, installed: false };
  await run(launcher, ['browser', 'install']);
  return { ...(await browserStatus(launcher, { run })), installed: true };
}
