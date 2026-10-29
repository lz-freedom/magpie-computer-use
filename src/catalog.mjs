/**
 * 设置页的模型清单。magpie 的插件页面不能联网，也只能加载页面所在文件夹里的文件，
 * 因此插件每次被 magpie 加载时从网关读取模型列表，连同提供方的名称与图标写入 page/models.js。
 *
 * 数据都来自 magpie：模型与上下文长度、价格来自网关 /v1/models；提供方名称与图标来自 magpie 的
 * providers.json。图标引用 `file:<名称>` 指 magpie 配置目录 icons/ 下的文件；其余名称是 magpie 内置的
 * 图标名，与 LobeHub 图标库（@lobehub/icons-static-svg）的文件名一致，从该依赖读取。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PROJECT_ROOT, defaultMagpieConfigDirectory } from './config.mjs';
import { createGatewayClient, supportsComputerUse } from './gateway.mjs';
import { browserStatus, discoverLcu, ensureBrowserConnector } from './lcu.mjs';
import { normalizeOptions } from './options.mjs';

export const CATALOG_PATH = path.join(PROJECT_ROOT, 'page/models.js');

// magpie 的路由组（auto/…）没有提供方条目，显示名用中文。
const BUILTIN_PROVIDER_NAMES = { auto: '路由组' };
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.gif': 'image/gif' };
// 大于此尺寸的位图图标先缩小为 64px PNG，避免清单文件过大；SVG 过大时不使用。
const MAX_INLINE_BYTES = 48 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** 用 macOS 自带的 sips 把位图缩小为 64px PNG；不可用或失败时返回 null。 */
function shrinkRaster(file) {
  return new Promise(resolve => {
    const out = path.join(os.tmpdir(), `magpie-cu-icon-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    execFile('/usr/bin/sips', ['-Z', '64', '-s', 'format', 'png', file, '--out', out], { timeout: 10_000 }, async error => {
      const data = error ? null : await fs.readFile(out).catch(() => null);
      await fs.rm(out, { force: true });
      resolve(data && data.length <= MAX_INLINE_BYTES ? data : null);
    });
  });
}

function lobeIconDirectory() {
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve('@lobehub/icons-static-svg/package.json')), 'icons');
  } catch {
    return null;
  }
}

/** 读取一个图标文件为 data URI；单色 SVG（fill="currentColor"）标记为 mono，页面用遮罩按主题着色。 */
async function iconFile(file) {
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return null;
  try {
    const data = await fs.readFile(file);
    if (data.length > MAX_SOURCE_BYTES) return null;
    if (type === 'image/svg+xml') {
      if (data.length > MAX_INLINE_BYTES) return null;
      const mono = /fill="currentColor"/.test(data.toString('utf8', 0, 400));
      return { src: `data:${type};base64,${data.toString('base64')}`, mono };
    }
    if (data.length <= MAX_INLINE_BYTES) return { src: `data:${type};base64,${data.toString('base64')}`, mono: false };
    const small = await shrinkRaster(file);
    return small ? { src: `data:image/png;base64,${small.toString('base64')}`, mono: false } : null;
  } catch {
    return null;
  }
}

/** magpie 的图标引用 → { src, mono }，找不到时返回 null（页面显示首字母）。 */
export async function resolveIcon(reference, { iconsDirectory, lobeDirectory = lobeIconDirectory() } = {}) {
  if (typeof reference !== 'string' || !reference) return null;
  if (reference.startsWith('file:')) {
    const name = path.basename(reference.slice(5));
    return iconsDirectory ? iconFile(path.join(iconsDirectory, name)) : null;
  }
  if (!/^[a-z0-9.-]+$/i.test(reference) || !lobeDirectory) return null;
  return iconFile(path.join(lobeDirectory, `${reference}.svg`));
}

/** 读取 magpie 的提供方配置，只取 id、名称与图标引用（不读取密钥等其他字段）。 */
export async function readProviders(directory) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory, 'providers.json'), 'utf8'));
    const list = Array.isArray(value?.providers) ? value.providers : [];
    return new Map(list.filter(item => typeof item?.id === 'string').map(item => [item.id, {
      name: typeof item.name === 'string' && item.name ? item.name : null,
      icon: typeof item.icon === 'string' ? item.icon : null,
    }]));
  } catch {
    return new Map();
  }
}

const isFree = model => model?.pricing && Number(model.pricing.prompt) === 0 && Number(model.pricing.completion) === 0;

/** 网关模型 → 页面用的清单：只保留能执行 computer_use 的模型；提供方按模型出现的顺序排列。 */
export function buildCatalog(models, { gatewayUrl, providers = new Map(), icons = new Map(), now = new Date() } = {}) {
  const usable = models.filter(model => typeof model?.id === 'string' && supportsComputerUse(model) !== false);
  const providerList = new Map();
  const entries = usable.map(model => {
    const provider = model.id.includes('/') ? model.id.slice(0, model.id.indexOf('/')) : '';
    const [name, labelProvider] = String(model.magpie_label ?? model.display_name ?? '').split(' · ');
    if (!providerList.has(provider)) {
      const label = BUILTIN_PROVIDER_NAMES[provider] ?? providers.get(provider)?.name ?? labelProvider ?? provider;
      providerList.set(provider, { id: provider, label: label || provider || '其他', icon: icons.get(provider) ?? null });
    }
    const context = Number(model.context_window ?? model.context_length);
    return {
      id: model.id,
      name: model.display_name || name || model.id,
      provider,
      context: Number.isFinite(context) && context > 0 ? context : null,
      free: Boolean(isFree(model)),
    };
  });
  return { generatedAt: now.toISOString(), gatewayUrl, providers: [...providerList.values()], models: entries };
}

/** 以先写临时文件再改名的方式写入，避免页面读到半个文件。 */
export async function writeCatalog(catalog, file = CATALOG_PATH) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `globalThis.MAGPIE_CU_CATALOG = ${JSON.stringify(catalog)};\n`);
  await fs.rename(temporary, file);
}

/** 为清单中出现的每个提供方解析图标：先用 providers.json 中的引用，再按提供方 id 查内置图标。 */
async function providerIcons(ids, providers, iconsDirectory) {
  const icons = new Map();
  for (const id of ids) {
    const icon = await resolveIcon(providers.get(id)?.icon, { iconsDirectory }) ?? await resolveIcon(id, { iconsDirectory });
    if (icon) icons.set(id, icon);
  }
  return icons;
}

/**
 * 读取网关模型并写入清单。网关暂时不可用（例如 magpie 刚启动）时重试几次；
 * 最终失败则写入带错误说明的清单，页面改为手动输入模型名称。从不抛出，不影响插件加载。
 */
/**
 * 设置页显示的浏览器状态。开关打开时顺便确保 Chrome 连接器指向本 LCU（lcu browser install），
 * 关闭时只读取状态。LCU 不可用或命令失败时给出原因，不影响模型清单。
 */
export async function readBrowserState(options, { discover = discoverLcu, status = browserStatus, connect = ensureBrowserConnector } = {}) {
  try {
    const info = await discover();
    const result = options.chrome ? await connect(info.launcher) : await status(info.launcher);
    return { connector: result.connector, extension: result.extension, installed: Boolean(result.installed) };
  } catch (error) {
    return { connector: 'unknown', extension: 'unknown', error: error.message };
  }
}

export async function refreshCatalog(rawOptions, {
  directory = defaultMagpieConfigDirectory(), createGateway = createGatewayClient,
  file = CATALOG_PATH, attempts = 3, retryDelayMs = 2000, browser = readBrowserState,
} = {}) {
  let options;
  try { options = normalizeOptions(rawOptions); } catch { options = normalizeOptions({}); }
  const browserState = await browser(options);
  const gateway = createGateway({ url: options.gatewayUrl, key: options.gatewayKey, timeoutMs: 10_000 });
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const models = await gateway.listModels();
      const providers = await readProviders(directory);
      const draft = buildCatalog(models, { gatewayUrl: options.gatewayUrl, providers });
      const icons = await providerIcons(draft.providers.map(item => item.id), providers, path.join(directory, 'icons'));
      const catalog = { ...buildCatalog(models, { gatewayUrl: options.gatewayUrl, providers, icons, now: new Date(draft.generatedAt) }), browser: browserState };
      await writeCatalog(catalog, file);
      return catalog;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
  const failed = { generatedAt: new Date().toISOString(), gatewayUrl: options.gatewayUrl, providers: [], models: [], browser: browserState, error: lastError?.message ?? '未知错误' };
  await writeCatalog(failed, file).catch(() => {});
  return failed;
}
