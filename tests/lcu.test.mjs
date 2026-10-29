import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  LcuNotFoundError, assertCompatible, candidateRoots, compareVersions, discoverLcu, findOnPath, inspectLcuRoot, loadLcuClient, resolveRoot,
} from '../src/lcu.mjs';

// 构造与 LCU 安装器相同布局的假安装：releases/<版本>-<哈希>，current 指向它。
async function fakeInstall(root, {
  version = '0.13.2', hash = 'df2700b2d2e5', platform = 'darwin', architecture = 'arm64',
  client = true, nodePath = process.execPath, app = true,
} = {}) {
  const release = path.join(root, 'releases', `${version}-${hash}`);
  await fs.mkdir(path.join(release, 'bin'), { recursive: true });
  await fs.writeFile(path.join(release, 'bin/lcu'), `#!/bin/sh\necho "lcu ${version} (test)"\n`, { mode: 0o755 });
  if (client) {
    await fs.mkdir(path.join(release, 'adapters'), { recursive: true });
    await fs.writeFile(path.join(release, 'adapters/client.mjs'), 'export function createCuaClient() { return {}; }\n');
  }
  const appPath = path.join(root, 'ChatGPT.app');
  if (app) await fs.mkdir(appPath, { recursive: true });
  await fs.writeFile(path.join(release, 'installation.json'), JSON.stringify({
    platform, architecture, package_version: '26.1023.50603', runtime: '0.0.35/test', app: appPath,
  }));
  await fs.writeFile(path.join(release, 'node-path'), `${nodePath}\n`);
  await fs.symlink(release, path.join(root, 'current'));
  return { root, release, launcher: path.join(release, 'bin/lcu'), client: path.join(release, 'adapters/client.mjs') };
}

async function withTemp(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcu-lcu-'));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const noPath = () => undefined;

test('按 LCU_PREFIX 找到当前安装，并从发布目录名读取版本', async () => withTemp(async root => {
  const prefix = path.join(root, 'lcu');
  const install = await fakeInstall(prefix);
  const info = await discoverLcu({ env: { LCU_PREFIX: prefix }, home: path.join(root, 'home'), lookPath: noPath });
  assert.equal(info.version, '0.13.2');
  assert.equal(info.source, 'LCU_PREFIX');
  assert.equal(info.root, await fs.realpath(install.release));
  assert.equal(info.launcher, path.join(await fs.realpath(install.release), 'bin/lcu'));
  assert.equal(info.app, path.join(prefix, 'ChatGPT.app'));
}));

test('MAGPIE_CU_LCU 可以直接指向启动器文件，符号链接先解析再定位安装根目录', async () => withTemp(async root => {
  const install = await fakeInstall(path.join(root, 'lcu'));
  const linked = path.join(root, 'bin-link');
  await fs.mkdir(linked);
  await fs.symlink(install.launcher, path.join(linked, 'lcu'));
  const info = await discoverLcu({ env: { MAGPIE_CU_LCU: path.join(linked, 'lcu') }, home: path.join(root, 'home'), lookPath: noPath });
  assert.equal(info.source, 'MAGPIE_CU_LCU');
  assert.equal(info.root, await fs.realpath(install.release));
}));

test('无效的候选位置会被跳过，并在可用时回退到下一个位置', async () => withTemp(async root => {
  const broken = path.join(root, 'broken');
  await fakeInstall(broken, { client: false });
  const good = path.join(root, 'good');
  await fakeInstall(good);
  const info = await discoverLcu({ env: { MAGPIE_CU_LCU: path.join(broken, 'current'), LCU_PREFIX: good }, home: path.join(root, 'home'), lookPath: noPath });
  assert.equal(info.source, 'LCU_PREFIX');
  assert.equal(info.version, '0.13.2');
}));

test('全部候选都无效时抛出 LcuNotFoundError，并列出每个位置的原因', async () => withTemp(async root => {
  await assert.rejects(
    discoverLcu({ env: { LCU_PREFIX: path.join(root, 'missing') }, home: path.join(root, 'home'), lookPath: noPath }),
    error => {
      assert.ok(error instanceof LcuNotFoundError);
      assert.match(error.message, /找不到可用的 LCU/);
      assert.ok(error.attempts.length >= 1);
      assert.match(error.message, /不可用/);
      return true;
    },
  );
}));

test('拒绝非 darwin-arm64 的安装，并说明原因', async () => withTemp(async root => {
  const install = await fakeInstall(path.join(root, 'lcu'), { platform: 'linux', architecture: 'x64' });
  const result = await inspectLcuRoot(install.release);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /darwin-arm64/);
}));

test('ChatGPT 应用缺失或 node-path 不可执行时报告问题', async () => withTemp(async root => {
  const install = await fakeInstall(path.join(root, 'lcu'), { app: false, nodePath: path.join(root, 'no-such-node') });
  const result = await inspectLcuRoot(install.release);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /ChatGPT 应用不存在/);
  assert.match(result.problems.join('\n'), /node-path/);
}));

test('目录名没有版本时使用 lcu --version 的输出', async () => withTemp(async root => {
  const install = await fakeInstall(path.join(root, 'lcu'));
  const source = path.join(root, 'checkout');
  await fs.mkdir(path.join(source, 'bin'), { recursive: true });
  await fs.mkdir(path.join(source, 'adapters'));
  await fs.copyFile(install.launcher, path.join(source, 'bin/lcu'));
  await fs.copyFile(install.client, path.join(source, 'adapters/client.mjs'));
  await fs.copyFile(path.join(install.release, 'installation.json'), path.join(source, 'installation.json'));
  await fs.copyFile(path.join(install.release, 'node-path'), path.join(source, 'node-path'));
  const result = await inspectLcuRoot(source, { versionOf: async () => '0.12.1' });
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.12.1');
}));

test('版本低于插件要求时拒绝，达到要求时通过', () => {
  assert.throws(() => assertCompatible({ version: '0.10.0' }), /低于本插件要求的 0\.11\.4/);
  assert.doesNotThrow(() => assertCompatible({ version: '0.11.4' }));
  assert.doesNotThrow(() => assertCompatible({ version: '0.13.2' }));
});

test('版本比较按数字而非字符串', () => {
  assert.ok(compareVersions('0.13.2', '0.9.0') > 0);
  assert.ok(compareVersions('0.11.4', '0.11.4') === 0);
  assert.ok(compareVersions('0.10.0', '0.11.0') < 0);
});

test('resolveRoot 只接受 bin/lcu 启动器或目录', async () => withTemp(async root => {
  const install = await fakeInstall(path.join(root, 'lcu'));
  assert.equal(await resolveRoot(path.join(root, 'lcu', 'current')), await fs.realpath(install.release));
  await fs.writeFile(path.join(root, 'other'), 'x');
  await assert.rejects(resolveRoot(path.join(root, 'other')), /不是 LCU 启动器或安装目录/);
}));

test('候选位置的优先级：环境变量、LCU_PREFIX、默认位置、PATH', () => {
  const candidates = candidateRoots({
    env: { MAGPIE_CU_LCU: '/a/lcu', LCU_PREFIX: '/b' }, home: '/home/u', lookPath: () => '/c/bin/lcu',
  });
  assert.deepEqual(candidates.map(item => item.source), ['MAGPIE_CU_LCU', 'LCU_PREFIX', 'PATH 中的 lcu']);
  assert.equal(candidates[1].location, '/b/current');
  const defaults = candidateRoots({ env: {}, home: '/home/u', lookPath: noPath });
  assert.equal(defaults[0].location, '/home/u/.local/share/lcu/current');
});

test('findOnPath 只返回可执行文件', async () => withTemp(async root => {
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'lcu'), '#!/bin/sh\n', { mode: 0o644 });
  assert.equal(findOnPath('lcu', bin), undefined);
  await fs.chmod(path.join(bin, 'lcu'), 0o755);
  assert.equal(findOnPath('lcu', bin), path.join(bin, 'lcu'));
}));

test('loadLcuClient 从该安装的 adapters/client.mjs 取得 createCuaClient，缺失时给出明确错误', async () => withTemp(async root => {
  const install = await fakeInstall(path.join(root, 'lcu'));
  const info = await inspectLcuRoot(install.release);
  assert.equal(typeof await loadLcuClient(info), 'function');
  // 另建一个安装：ESM 会缓存同一路径的模块，因此不能在原路径上改写后再次导入。
  const stale = await fakeInstall(path.join(root, 'old'), { version: '0.11.4', hash: 'aaaaaaaaaaaa' });
  await fs.writeFile(stale.client, 'export const other = 1;\n');
  const staleInfo = await inspectLcuRoot(stale.release);
  await assert.rejects(loadLcuClient(staleInfo), /缺少 createCuaClient/);
}));
