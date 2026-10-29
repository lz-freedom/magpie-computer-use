import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { buildCatalog, readProviders, refreshCatalog, resolveIcon, writeCatalog } from '../src/catalog.mjs';
import { PROJECT_ROOT } from '../src/config.mjs';

// vm 上下文中创建的对象原型不同，严格深比较前先复制到当前上下文。
const plain = value => JSON.parse(JSON.stringify(value));

// 在没有 DOM 的上下文中载入设置页脚本，只取其中的纯函数。
async function loadPage() {
  const context = vm.createContext({});
  vm.runInContext(await fs.readFile(path.join(PROJECT_ROOT, 'page/app.js'), 'utf8'), context);
  return context.MagpieComputerUseSettings;
}

// 随机像素的 PNG：几乎无法压缩，用来构造超过内嵌上限的位图。
function noisyPng(size) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = data => { let c = 0xffffffff; for (const byte of data) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.from([0]), randomBytes(size * 3));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

async function withTemp(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcu-page-'));
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

const VISION = { modalities: { input: ['text', 'image'] }, tool_call: true };
const GATEWAY_MODELS = [
  { id: 'auto/gpt-6-luna', magpie_label: 'GPT-6 Luna · routing group', context_window: 922000, ...VISION },
  { id: 'relay-anthropic/claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', magpie_label: 'Claude Sonnet 5.5 · relay-anthropic', context_window: 1000000, pricing: { prompt: '0.000003', completion: '0.000015' }, ...VISION },
  { id: 'opencode-zen/glm-5.3-flash-free', display_name: 'GLM-5.3-Flash Free', magpie_label: 'GLM-5.3-Flash Free · OpenCode Zen', context_window: 200000, pricing: { prompt: '0', completion: '0' }, ...VISION },
  { id: 'zero-cat/kimi-k3-free', magpie_label: 'kimi-k3-free · zero.cat', modalities: { input: ['text'] }, tool_call: true },
  { id: 'relay-anthropic/claude-haiku-5-5', display_name: 'Claude Haiku 5.5', magpie_label: 'Claude Haiku 5.5 · relay-anthropic', context_window: 1000000, ...VISION },
];
const PROVIDERS = new Map([['opencode-zen', { name: 'OpenCode Zen', icon: 'opencode' }], ['relay-anthropic', { name: 'relay-anthropic', icon: 'file:x.svg' }]]);

/* ---- 模型清单 ---- */

test('清单只保留能执行 computer_use 的模型，带上上下文长度、是否免费与提供方', () => {
  const catalog = buildCatalog(GATEWAY_MODELS, { gatewayUrl: 'http://127.0.0.1:3425', providers: PROVIDERS, now: new Date('2026-10-28T12:00:00Z') });
  assert.equal(catalog.generatedAt, '2026-10-28T12:00:00.000Z');
  assert.deepEqual(catalog.models.map(model => model.id), ['auto/gpt-6-luna', 'relay-anthropic/claude-sonnet-5-5', 'opencode-zen/glm-5.3-flash-free', 'relay-anthropic/claude-haiku-5-5']);
  assert.deepEqual(catalog.models[1], { id: 'relay-anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', provider: 'relay-anthropic', context: 1000000, free: false });
  assert.equal(catalog.models[2].free, true);
  // 提供方按首次出现的顺序；名称优先用 providers.json，路由组显示为中文
  assert.deepEqual(catalog.providers.map(item => [item.id, item.label]), [['auto', '路由组'], ['relay-anthropic', 'relay-anthropic'], ['opencode-zen', 'OpenCode Zen']]);
});

test('读取 providers.json 只取 id、名称与图标引用', async () => withTemp(async root => {
  await fs.writeFile(path.join(root, 'providers.json'), JSON.stringify({ providers: [
    { id: 'p1', name: 'P One', icon: 'file:a.png', key: 'secret-key' }, { id: 'p2', name: '', icon: 'openai' }, { name: 'no id' },
  ] }));
  const providers = await readProviders(root);
  assert.deepEqual([...providers.entries()], [['p1', { name: 'P One', icon: 'file:a.png' }], ['p2', { name: null, icon: 'openai' }]]);
  assert.equal(JSON.stringify([...providers.values()]).includes('secret'), false);
  assert.deepEqual([...(await readProviders(path.join(root, 'missing'))).entries()], []);
}));

test('图标：file: 引用读取 magpie 的 icons 目录；内置名称读取 LobeHub 图标；单色 SVG 标记为 mono', async () => withTemp(async root => {
  await fs.writeFile(path.join(root, 'color.svg'), '<svg viewBox="0 0 1 1"><rect fill="#f00"/></svg>');
  const fromFile = await resolveIcon('file:color.svg', { iconsDirectory: root });
  assert.match(fromFile.src, /^data:image\/svg\+xml;base64,/);
  assert.equal(fromFile.mono, false);
  const builtin = await resolveIcon('opencode', { iconsDirectory: root });
  assert.match(builtin.src, /^data:image\/svg\+xml;base64,/);
  assert.equal(builtin.mono, true);
  assert.equal((await resolveIcon('minimax-color', { iconsDirectory: root })).mono, false);
  // 路径穿越与未知名称不读取
  assert.equal(await resolveIcon('file:../../etc/passwd', { iconsDirectory: root }), null);
  assert.equal(await resolveIcon('../secret', { iconsDirectory: root }), null);
  assert.equal(await resolveIcon('no-such-icon-name', { iconsDirectory: root }), null);
}));

test('图标：较大的位图缩小为 64px PNG 后内嵌', { skip: process.platform !== 'darwin' }, async () => withTemp(async root => {
  const big = path.join(root, 'big.png');
  await fs.writeFile(big, noisyPng(160));
  assert.ok((await fs.stat(big)).size > 48 * 1024, '测试图片应超过内嵌上限');
  const icon = await resolveIcon('file:big.png', { iconsDirectory: root });
  assert.ok(icon, '应得到缩小后的图标');
  assert.match(icon.src, /^data:image\/png;base64,/);
  assert.ok(Buffer.from(icon.src.split(',')[1], 'base64').length <= 48 * 1024);
}));

test('清单写成页面可直接加载的脚本', async () => withTemp(async root => {
  const file = path.join(root, 'models.js');
  await writeCatalog({ generatedAt: 'x', gatewayUrl: 'y', providers: [], models: [{ id: 'a/b' }] }, file);
  const context = vm.createContext({});
  vm.runInContext(await fs.readFile(file, 'utf8'), context);
  assert.equal(context.MAGPIE_CU_CATALOG.models[0].id, 'a/b');
  assert.deepEqual(await fs.readdir(root), ['models.js']);
}));

const BROWSER = { connector: 'lcu', extension: 'unknown', installed: false };

test('生成清单：使用 magpie 配置目录中的提供方与图标；网关暂时不可用时重试', async () => withTemp(async root => {
  await fs.mkdir(path.join(root, 'icons'));
  await fs.writeFile(path.join(root, 'icons', 'x.svg'), '<svg viewBox="0 0 1 1"><rect fill="#00f"/></svg>');
  await fs.writeFile(path.join(root, 'providers.json'), JSON.stringify({ providers: [...PROVIDERS].map(([id, value]) => ({ id, ...value })) }));
  const file = path.join(root, 'models.js');
  let calls = 0;
  const flaky = () => ({ listModels: async () => { calls += 1; if (calls < 2) throw new Error('无法连接 magpie 网关'); return GATEWAY_MODELS; } });
  const catalog = await refreshCatalog({}, { directory: root, createGateway: flaky, file, retryDelayMs: 1, browser: async () => BROWSER });
  assert.equal(calls, 2);
  const icons = Object.fromEntries(catalog.providers.map(item => [item.id, item.icon && (item.icon.mono ? 'mono' : 'color')]));
  assert.deepEqual(icons, { auto: null, 'relay-anthropic': 'color', 'opencode-zen': 'mono' });
  assert.deepEqual(catalog.browser, BROWSER, '浏览器状态随清单写入');
}));

test('生成清单：最终失败时写入带错误说明的清单，不抛出；选项写错时用默认网关', async () => withTemp(async root => {
  const file = path.join(root, 'models.js');
  const down = () => ({ listModels: async () => { throw new Error('无法连接 magpie 网关'); } });
  const failed = await refreshCatalog(undefined, { directory: root, createGateway: down, file, attempts: 2, retryDelayMs: 1, browser: async () => BROWSER });
  assert.match(failed.error, /无法连接/);
  assert.deepEqual(failed.browser, BROWSER, '网关不可用时仍写入浏览器状态');
  const seen = [];
  await refreshCatalog({ tools: 'nonsense' }, { directory: root, createGateway: config => { seen.push(config.url); return { listModels: async () => [] }; }, file, browser: async () => BROWSER });
  assert.deepEqual(seen, ['http://127.0.0.1:3425']);
}));

/* ---- 设置页 ---- */

test('设置页：上下文徽标只标出 100 万以上', async () => {
  const page = await loadPage();
  assert.equal(page.contextBadge(1_000_000), '1M');
  assert.equal(page.contextBadge(2_000_000), '2M');
  assert.equal(page.contextBadge(1_500_000), '1.5M');
  assert.equal(page.contextBadge(922_000), null);
  assert.equal(page.contextBadge(null), null);
});

test('设置页：选择器的行——未设置、按提供方分组、提供方筛选、多词搜索、手动输入 ID', async () => {
  const page = await loadPage();
  const catalog = buildCatalog(GATEWAY_MODELS, { gatewayUrl: 'g', providers: PROVIDERS });
  const kinds = rows => plain(rows.map(row => row.type === 'model' ? row.model.id : row.type === 'group' ? `#${row.label}` : row.type));

  // 同一提供方的模型即使在网关列表中不相邻，也归入同一组
  assert.deepEqual(kinds(page.pickerRows(catalog)), [
    'reset', '#路由组', 'auto/gpt-6-luna', '#relay-anthropic', 'relay-anthropic/claude-sonnet-5-5', 'relay-anthropic/claude-haiku-5-5',
    '#OpenCode Zen', 'opencode-zen/glm-5.3-flash-free',
  ]);
  assert.deepEqual(kinds(page.pickerRows(catalog, { provider: 'relay-anthropic' })), ['#relay-anthropic', 'relay-anthropic/claude-sonnet-5-5', 'relay-anthropic/claude-haiku-5-5']);
  assert.deepEqual(kinds(page.pickerRows(catalog, { query: 'claude 5' })), ['#relay-anthropic', 'relay-anthropic/claude-sonnet-5-5', 'relay-anthropic/claude-haiku-5-5']);
  assert.deepEqual(kinds(page.pickerRows(catalog, { query: 'opencode' })), ['#OpenCode Zen', 'opencode-zen/glm-5.3-flash-free']);
  assert.deepEqual(kinds(page.pickerRows(catalog, { query: 'my/model' })), ['custom']);
  assert.equal(page.pickerRows(catalog, { query: 'my/model' })[0].id, 'my/model');
  // 输入的 ID 已在列表中时不再提供手动输入
  assert.deepEqual(kinds(page.pickerRows(catalog, { query: 'auto/gpt-6-luna' })), ['#路由组', 'auto/gpt-6-luna']);
  assert.deepEqual(kinds(page.pickerRows(undefined, { query: 'x/y' })), ['custom']);
});

test('设置页：已有选项回填，不合法的值回落到默认值', async () => {
  const page = await loadPage();
  assert.deepEqual(plain(page.formState({ model: ' a/b ', tools: 'delegate', approval: 'auto', executorEffort: 'high', maxSteps: 12, evidenceImages: 0, keepScreenshots: 2 })), { model: 'a/b', tools: 'delegate', approval: 'auto', executorEffort: 'high', chrome: false, maxSteps: 12, evidenceImages: 0 });
  assert.deepEqual(plain(page.formState({ model: '', tools: 'bogus', executorEffort: 'minimal', chrome: 'yes', maxSteps: 999 })), { model: null, tools: 'both', approval: 'manual', executorEffort: 'medium', chrome: false, maxSteps: 40, evidenceImages: 4 });
  assert.deepEqual(plain(page.formState(null)), { model: null, tools: 'both', approval: 'manual', executorEffort: 'medium', chrome: false, maxSteps: 40, evidenceImages: 4 });
  assert.equal(page.formState({ chrome: true }).chrome, true);
});

test('设置页：校验与 options.mjs 的范围一致', async () => {
  const page = await loadPage();
  const base = { model: 'a/b', tools: 'both', approval: 'manual', executorEffort: 'medium', chrome: true, maxSteps: 40, evidenceImages: 4 };
  assert.deepEqual(plain(page.validate(base).values), base);
  assert.equal(page.validate({ ...base, model: null }).values.model, null);
  assert.equal(page.validate({ ...base, model: 'no-slash' }).field, 'model');
  assert.equal(page.validate({ ...base, maxSteps: 0 }).field, 'maxSteps');
  assert.equal(page.validate({ ...base, maxSteps: 2.5 }).field, 'maxSteps');
  assert.equal(page.validate({ ...base, tools: 'x' }).field, 'tools');
  assert.equal(page.validate({ ...base, evidenceImages: 11 }).field, 'evidenceImages');
  assert.equal(page.validate({ ...base, evidenceImages: 0 }).values.evidenceImages, 0);
  assert.equal(page.validate({ ...base, approval: 'always' }).field, 'approval');
  assert.equal(page.validate({ ...base, executorEffort: 'none' }).field, 'executorEffort');
  assert.equal(page.validate({ ...base, executorEffort: 'auto' }).values.executorEffort, 'auto');
});

test('设置页：保存时保留页面未管理的选项、去掉早期选项，未设置模型时去掉 model', async () => {
  const page = await loadPage();
  const latest = { model: 'old/model', gatewayUrl: 'http://127.0.0.1:9999', maxTokens: 2048, executor: 'wrapped', keepScreenshots: 5, executorApi: 'responses' };
  const merged = page.mergeOptions(latest, { model: null, tools: 'delegate', approval: 'agent', executorEffort: 'xhigh', maxSteps: 10, evidenceImages: 2 });
  assert.deepEqual(plain(merged), { gatewayUrl: 'http://127.0.0.1:9999', maxTokens: 2048, tools: 'delegate', approval: 'agent', executorEffort: 'xhigh', maxSteps: 10, evidenceImages: 2 });
  assert.equal(page.mergeOptions(null, { model: 'n/m', tools: 'both', maxSteps: 40 }).model, 'n/m');
});

test('设置页：页面保存的选项能通过插件的选项校验', async () => {
  const { normalizeOptions } = await import('../src/options.mjs');
  const page = await loadPage();
  const { values } = page.validate({ model: 'a/b', tools: 'delegate', approval: 'auto', executorEffort: 'max', maxSteps: 200, evidenceImages: 10 });
  const options = normalizeOptions(page.mergeOptions({}, values), {});
  assert.equal(options.model, 'a/b');
  assert.equal(options.tools, 'delegate');
  assert.equal(options.approval, 'auto');
  assert.equal(options.maxSteps, 200);
  assert.equal(options.executorEffort, 'max');
  assert.equal(options.evidenceImages, 10);
});

test('设置页：清单说明区分未生成、失败与正常三种情况', async () => {
  const page = await loadPage();
  assert.match(page.catalogNote(undefined), /尚未生成/);
  assert.match(page.catalogNote({ error: '无法连接', models: [] }), /读取模型列表失败：无法连接/);
  assert.match(page.catalogNote({ generatedAt: '2026-10-28T12:00:00Z', gatewayUrl: 'http://g', models: [{}, {}] }), /^2 个可用模型（来自 magpie 网关） · \d{2}\/\d{2} \d{2}:\d{2} 更新$/);
});

test('设置页：浏览器状态显示连接器与扩展检查，读不到 Chrome 配置时如实说明', async () => {
  const page = await loadPage();
  const brief = browser => plain(page.browserChecks(browser)).map(check => [check.label, check.level, check.value]);
  assert.deepEqual(brief({ connector: 'lcu', extension: 'enabled' }), [['连接器', 'ok', '已指向 LCU'], ['ChatGPT 扩展', 'ok', '已启用']]);
  assert.deepEqual(brief({ connector: 'other', extension: 'missing' }), [['连接器', 'todo', '还没指向 LCU'], ['ChatGPT 扩展', 'todo', '没有安装或没有启用']]);
  const [connector, extension] = plain(page.browserChecks({ connector: 'lcu', extension: 'unknown', installed: true }));
  assert.match(connector.hint, /刚刚配置：请重启 Chrome/);
  assert.equal(extension.value, '无法确认');
  assert.match(extension.link.url, /chromewebstore\.google\.com/);
  assert.deepEqual(brief({ error: '找不到可用的 LCU' }), [['状态', 'warn', '无法检测']]);
  assert.deepEqual(brief(undefined), [['状态', 'warn', '还没有检测结果']]);
});
