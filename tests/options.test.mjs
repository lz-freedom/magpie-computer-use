import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../src/config.mjs';
import { DEFAULT_OPTIONS, normalizeOptions, readPluginOptions } from '../src/options.mjs';
import { findPluginEntry } from '../src/plugin-entry.mjs';

test('没有任何选项时使用默认值', () => {
  assert.deepEqual(normalizeOptions(undefined, {}), { ...DEFAULT_OPTIONS });
  assert.equal(DEFAULT_OPTIONS.model, null);
  assert.equal(DEFAULT_OPTIONS.tools, 'both');
});

test('合法选项被采用，未知字段被忽略，空 model 视为未设置', () => {
  const options = normalizeOptions({
    model: ' relay-anthropic/claude-sonnet-5-5 ', tools: 'delegate', maxSteps: 12, keepScreenshots: 2, executor: 'wrapped',
    maxTokens: 2048, gatewayUrl: 'http://127.0.0.1:9999/', gatewayKey: 'k', future: true,
  }, {});
  assert.equal(options.model, 'relay-anthropic/claude-sonnet-5-5');
  assert.equal(options.tools, 'delegate');
  assert.equal(options.maxSteps, 12);
  assert.equal('keepScreenshots' in options, false, '早期选项被忽略');
  assert.equal('executor' in options, false);
  assert.equal(options.maxTokens, 2048);
  assert.equal(options.gatewayUrl, 'http://127.0.0.1:9999');
  assert.equal(options.gatewayKey, 'k');
  assert.equal('future' in options, false);
  assert.equal(normalizeOptions({ model: '' }, {}).model, null);
});

test('类型或范围错误时给出明确提示', () => {
  assert.throws(() => normalizeOptions({ tools: 'all' }, {}), /tools 应为 delegate \/ direct \/ both/);
  assert.throws(() => normalizeOptions({ maxSteps: 0 }, {}), /maxSteps 应为 1–200/);
  assert.throws(() => normalizeOptions({ evidenceImages: 2.5 }, {}), /evidenceImages/);
  assert.throws(() => normalizeOptions({ model: 3 }, {}), /model 应为模型名称/);
  assert.throws(() => normalizeOptions({ gatewayUrl: 'ftp://x' }, {}), /gatewayUrl/);
  assert.throws(() => normalizeOptions({ executorEffort: 'turbo' }, {}), /executorEffort 应为 auto/);
});

test('推理强度：默认 medium，早期的 none / minimal 换成 low；直接操作默认用原版 js', () => {
  assert.equal(normalizeOptions({}, {}).executorEffort, 'medium');
  assert.equal(normalizeOptions({ executorEffort: 'max' }, {}).executorEffort, 'max');
  assert.equal(normalizeOptions({ executorEffort: 'none' }, {}).executorEffort, 'low');
  assert.equal(normalizeOptions({ executorEffort: 'minimal' }, {}).executorEffort, 'low');
  assert.equal(normalizeOptions({}, {}).direct, 'original');
});

test('环境变量临时覆盖模型与网关地址', () => {
  const options = normalizeOptions({ model: 'a/b' }, { MAGPIE_CU_MODEL: 'c/d', MAGPIE_CU_GATEWAY: 'http://localhost:1/' });
  assert.equal(options.model, 'c/d');
  assert.equal(options.gatewayUrl, 'http://localhost:1');
});

test('从 plugins.json 中本插件的条目读取选项（本地路径安装）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcu-options-'));
  try {
    await fs.writeFile(path.join(root, 'plugins.json'), JSON.stringify({ plugins: [
      { spec: 'other-plugin', options: { model: 'x/y' } },
      { spec: PROJECT_ROOT, options: { model: 'relay-codex/gpt-6-luna', tools: 'delegate' } },
    ] }));
    const entry = await findPluginEntry(root);
    assert.equal(entry.spec, PROJECT_ROOT);
    const options = await readPluginOptions({ directory: root, env: {} });
    assert.equal(options.model, 'relay-codex/gpt-6-luna');
    assert.equal(options.tools, 'delegate');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('插件不在安装列表中时使用默认值', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcu-options-'));
  try {
    await fs.writeFile(path.join(root, 'plugins.json'), JSON.stringify({ plugins: [{ spec: 'other-plugin' }] }));
    assert.deepEqual(await readPluginOptions({ directory: root, env: {} }), { ...DEFAULT_OPTIONS });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('应用授权方式：默认手动，只接受三种取值', async () => {
  assert.equal(normalizeOptions({}, {}).approval, 'manual');
  assert.equal(normalizeOptions({ approval: 'auto' }, {}).approval, 'auto');
  assert.throws(() => normalizeOptions({ approval: 'always' }, {}), /approval 应为 manual \/ agent \/ auto/);
});

test('evidenceImages：默认 4，范围 0–10', () => {
  assert.equal(normalizeOptions({}, {}).evidenceImages, 4);
  assert.equal(normalizeOptions({ evidenceImages: 0 }, {}).evidenceImages, 0);
  assert.throws(() => normalizeOptions({ evidenceImages: 11 }, {}), /evidenceImages 应为 0–10/);
});

