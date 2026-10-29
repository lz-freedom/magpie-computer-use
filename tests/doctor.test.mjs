import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { VERSION } from '../src/config.mjs';
import { formatReport, runDoctor } from '../src/doctor.mjs';
import { LcuNotFoundError } from '../src/lcu.mjs';
import { libraryMcpDefinition } from '../src/library.mjs';
import { normalizeOptions } from '../src/options.mjs';

async function tempConfig(content) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcu-doctor-'));
  const directory = path.join(root, 'magpie');
  await fs.mkdir(directory);
  if (content !== undefined) await fs.writeFile(path.join(directory, 'library.json'), JSON.stringify(content));
  return { directory, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

const info = {
  ok: true, root: '/fake/lcu/releases/0.13.2-df2700b2d2e5', source: '测试', version: '0.13.2',
  launcher: '/fake/lcu/bin/lcu', client: '/fake/lcu/adapters/client.mjs', app: '/Applications/ChatGPT.app', runtime: 'rt-1',
};

// 测试不访问真实网关与 magpie 配置。
const VISION = { modalities: { input: ['text', 'image'] }, tool_call: true };
const gatewayWith = models => () => ({ listModels: async () => models });
const OFFLINE = { createGateway: gatewayWith([]), findEntry: async () => null };

const statusOk = async () => ({ compatibility: { status: 'tested' }, app: { version: '26.1', runtime: 'rt-1' } });

test('未登记、LCU 正常时给出警告而不是错误，整体通过', async () => {
  const config = await tempConfig({ mcp: null });
  try {
    const report = await runDoctor({ ...OFFLINE, configDirectory: config.directory, discover: async () => info, readStatus: statusOk });
    const byName = Object.fromEntries(report.checks.map(check => [check.name, check]));
    assert.equal(byName['magpie 资源库'].status, 'warn');
    assert.equal(byName.LCU.status, 'ok');
    assert.equal(byName['LCU 兼容性'].status, 'ok');
    assert.equal(report.ok, true);
  } finally {
    await config.cleanup();
  }
});

test('资源库已登记到当前安装时显示正常', async () => {
  const definition = libraryMcpDefinition();
  const config = await tempConfig({ mcp: [{ ...definition, agents: ['claude'] }] });
  try {
    const report = await runDoctor({ ...OFFLINE, configDirectory: config.directory, discover: async () => info, readStatus: statusOk });
    const entry = report.checks.find(check => check.name === 'magpie 资源库');
    assert.equal(entry.status, 'ok');
    assert.match(entry.detail, /claude/);
  } finally {
    await config.cleanup();
  }
});

test('找不到 LCU 时报告错误并列出尝试过的位置', async () => {
  const config = await tempConfig({ mcp: null });
  try {
    const failure = new LcuNotFoundError([{ source: 'LCU_PREFIX', location: '/x/current', problems: ['不可用'] }]);
    const report = await runDoctor({ ...OFFLINE, configDirectory: config.directory, discover: async () => { throw failure; }, readStatus: statusOk });
    assert.equal(report.ok, false);
    const lcu = report.checks.find(check => check.name === 'LCU');
    assert.equal(lcu.status, 'error');
    assert.match(lcu.detail, /LCU_PREFIX/);
  } finally {
    await config.cleanup();
  }
});

test('低于最低版本时报告错误；未联调的版本给出警告', async () => {
  const config = await tempConfig({ mcp: null });
  try {
    const old = await runDoctor({ ...OFFLINE, configDirectory: config.directory, discover: async () => ({ ...info, version: '0.10.0' }), readStatus: statusOk });
    assert.equal(old.checks.find(check => check.name === 'LCU').status, 'error');
    const newer = await runDoctor({ ...OFFLINE, configDirectory: config.directory, discover: async () => ({ ...info, version: '0.14.0' }), readStatus: statusOk });
    assert.equal(newer.checks.find(check => check.name === 'LCU').status, 'warn');
  } finally {
    await config.cleanup();
  }
});

test('--live 连接运行时并列出公开工具，且总是关闭连接', async () => {
  const config = await tempConfig({ mcp: null });
  let closed = false;
  try {
    const report = await runDoctor({ ...OFFLINE,
      configDirectory: config.directory, live: true, discover: async () => info, readStatus: statusOk,
      connect: async () => ({
        info,
        client: {
          publicTools: () => [{ name: 'js_reset' }, { name: 'js' }],
          instructions: 'UI automation',
          close: async () => { closed = true; },
        },
      }),
    });
    const live = report.checks.find(check => check.name === '运行时连接');
    assert.equal(live.status, 'ok');
    assert.match(live.detail, /js, js_reset/);
    assert.equal(closed, true);
  } finally {
    await config.cleanup();
  }
});

test('formatReport 输出每项状态与结论', () => {
  const text = formatReport({ checks: [{ name: 'A', status: 'error', detail: 'x' }], ok: false });
  assert.match(text, /✘ A：x/);
  assert.match(text, /存在错误/);
});

test('命令行：--version、help 与未知命令', async () => {
  const chunks = [];
  const io = { stdout: { write: text => chunks.push(text) } };
  assert.equal(await main(['--version'], io), 0);
  assert.equal(chunks.at(-1), `${VERSION}\n`);
  assert.equal(await main([], io), 0);
  assert.match(chunks.at(-1), /magpie-computer-use mcp/);
  await assert.rejects(main(['nope'], io), /未知命令/);
});

test('命令行 unregister：没有指向当前安装的登记时不改动资源库', async () => {
  const config = await tempConfig({ mcp: null });
  try {
    const chunks = [];
    assert.equal(await main(['unregister', '--config-dir', config.directory], { stdout: { write: text => chunks.push(text) } }), 0);
    assert.match(chunks.join(''), /未做改动/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.directory, 'library.json'), 'utf8')), { mcp: null });
  } finally {
    await config.cleanup();
  }
});

test('委托模型：未设置时警告，设置且可用时正常，不支持图片或不存在时报错', async () => {
  const config = await tempConfig({ mcp: null });
  const base = { configDirectory: config.directory, discover: async () => info, readStatus: statusOk, findEntry: async () => ({ spec: 'x' }) };
  const modelCheck = report => report.checks.find(check => check.name === '委托模型');
  try {
    const models = [{ id: 'good/vision', magpie_label: 'Good', ...VISION }, { id: 'text/only', modalities: { input: ['text'] }, tool_call: true }];
    const unset = await runDoctor({ ...base, createGateway: gatewayWith(models), loadOptions: async () => normalizeOptions({}, {}) });
    assert.equal(modelCheck(unset).status, 'warn');
    assert.match(unset.checks.find(check => check.name === 'magpie 网关').detail, /1\/2 个模型/);

    const good = await runDoctor({ ...base, createGateway: gatewayWith(models), loadOptions: async () => normalizeOptions({ model: 'good/vision' }, {}) });
    assert.equal(modelCheck(good).status, 'ok');

    const textOnly = await runDoctor({ ...base, createGateway: gatewayWith(models), loadOptions: async () => normalizeOptions({ model: 'text/only' }, {}) });
    assert.equal(modelCheck(textOnly).status, 'error');

    const missing = await runDoctor({ ...base, createGateway: gatewayWith(models), loadOptions: async () => normalizeOptions({ model: 'no/such' }, {}) });
    assert.equal(modelCheck(missing).status, 'error');
    assert.equal(missing.ok, false);
  } finally {
    await config.cleanup();
  }
});

test('网关不可用时报错；选项写错时报错并提示修改方法', async () => {
  const config = await tempConfig({ mcp: null });
  const base = { configDirectory: config.directory, discover: async () => info, readStatus: statusOk, findEntry: async () => null };
  try {
    const down = await runDoctor({ ...base, loadOptions: async () => normalizeOptions({}, {}),
      createGateway: () => ({ listModels: async () => { throw new Error('无法连接 magpie 网关'); } }) });
    assert.equal(down.checks.find(check => check.name === 'magpie 网关').status, 'error');
    const bad = await runDoctor({ ...base, loadOptions: async () => normalizeOptions({ tools: 'x' }, {}), createGateway: gatewayWith([]) });
    const optionCheck = bad.checks.find(check => check.name === '插件选项');
    assert.equal(optionCheck.status, 'error');
    assert.match(optionCheck.detail, /magpie plugin options magpie-computer-use/);
  } finally {
    await config.cleanup();
  }
});
