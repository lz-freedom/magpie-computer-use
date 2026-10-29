import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BIN_PATH, PLUGIN_NAME } from '../src/config.mjs';
import {
  ensureLibraryMcp, isOwnEntry, libraryMcpDefinition, pendingMcpRemoval, readLibrary, removeLibraryMcp, sameDefinition,
} from '../src/library.mjs';

async function tempMagpie(content) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcu-library-'));
  const directory = path.join(root, 'magpie');
  await fs.mkdir(directory);
  if (content !== undefined) {
    await fs.writeFile(path.join(directory, 'library.json'), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { root, directory, file: path.join(directory, 'library.json') };
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// 模拟 magpie 的 `library mcp add|rm` 命令：只改动临时目录中的 library.json，并记录每次调用的参数。
function fakeMagpie(file) {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    const library = await readJsonFile(file).catch(() => ({ mcp: null }));
    const mcp = Array.isArray(library.mcp) ? library.mcp : [];
    if (args[1] === 'mcp' && args[2] === 'add') {
      const [, , , name, command, ...rest] = args;
      const agents = rest.pop().slice('agents='.length).split(',').filter(Boolean);
      mcp.push({ name, transport: 'stdio', command, args: rest, agents });
    } else if (args[1] === 'mcp' && args[2] === 'rm') {
      const index = mcp.findIndex(entry => entry.name === args[3]);
      if (index >= 0) mcp.splice(index, 1);
    }
    await fs.writeFile(file, JSON.stringify({ ...library, mcp }));
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

const OLD_LAUNCH = '/Users/someone/.config/magpie/plugins/node_modules/magpie-computer-use/bin/magpie-computer-use.mjs';

test('mcp 为 null（magpie 对空列表的写法）时按空列表读取，而不是报错', async () => {
  const { root, directory } = await tempMagpie({ instructions: { agents: [] }, mcp: null, skills: null, applied: { claude: {} } });
  try {
    const library = await readLibrary(directory);
    assert.deepEqual(library.mcp, []);
    assert.deepEqual(library.applied, { claude: {} });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('资源库文件不存在时视为空资源库', async () => {
  const { root, directory } = await tempMagpie();
  try {
    assert.deepEqual(await readLibrary(directory), { mcp: [] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('mcp 既不是数组也不是 null 时仍然拒绝，并给出原有提示', async () => {
  const { root, directory } = await tempMagpie({ mcp: {} });
  try {
    await assert.rejects(readLibrary(directory), /资源库应为对象，mcp 应为数组/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('根对象不是对象时拒绝读取', async () => {
  const { root, directory } = await tempMagpie('[]');
  try {
    await assert.rejects(readLibrary(directory), /无法读取 magpie 资源库/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('首次加载时登记 MCP，且不替用户选择 Agent', async () => {
  const { root, directory, file } = await tempMagpie({ mcp: null, applied: {} });
  try {
    const fake = fakeMagpie(file);
    const result = await ensureLibraryMcp({ directory }, undefined, {
      runner: fake.runner, launcher: process.execPath, magpie: '/fake/magpie', entry: BIN_PATH,
    });
    assert.equal(result.created, true);
    assert.equal(result.refreshed, false);
    const entry = (await readJsonFile(file)).mcp.find(item => item.name === PLUGIN_NAME);
    assert.deepEqual(entry, libraryMcpDefinition(process.execPath, BIN_PATH));
    assert.equal(fake.calls[0].at(-1), 'agents=');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('同一定义的条目保持原样，不调用 magpie', async () => {
  const definition = libraryMcpDefinition(process.execPath, BIN_PATH);
  const { root, directory, file } = await tempMagpie({ mcp: [{ ...definition, agents: ['claude'], disabledTools: ['drag'] }] });
  try {
    const fake = fakeMagpie(file);
    const result = await ensureLibraryMcp({ directory }, undefined, { runner: fake.runner, launcher: process.execPath, magpie: '/fake/magpie', entry: BIN_PATH });
    assert.equal(result.created, false);
    assert.equal(result.refreshed, false);
    assert.equal(fake.calls.length, 0);
    const stored = (await readJsonFile(file)).mcp[0];
    assert.deepEqual(stored.agents, ['claude']);
    assert.deepEqual(stored.disabledTools, ['drag']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('路径变化（例如安装位置改变）时刷新登记，并保留 Agent 选择', async () => {
  const { root, directory, file } = await tempMagpie({
    mcp: [{ name: PLUGIN_NAME, transport: 'stdio', command: process.execPath, args: [OLD_LAUNCH, 'mcp'], agents: ['claude', 'codex'] }],
  });
  try {
    const fake = fakeMagpie(file);
    const result = await ensureLibraryMcp({ directory }, undefined, { runner: fake.runner, launcher: process.execPath, magpie: '/fake/magpie', entry: BIN_PATH });
    assert.equal(result.refreshed, true);
    assert.deepEqual(fake.calls.map(args => args[2]), ['rm', 'add']);
    assert.equal(fake.calls[1].at(-1), 'agents=claude,codex');
    const stored = (await readJsonFile(file)).mcp.find(item => item.name === PLUGIN_NAME);
    assert.equal(stored.args[0], BIN_PATH);
    assert.deepEqual(stored.agents, ['claude', 'codex']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('同名的其他 MCP 不会被覆盖', async () => {
  const foreign = { name: PLUGIN_NAME, transport: 'stdio', command: '/usr/bin/python3', args: ['server.py'], agents: [] };
  const { root, directory, file } = await tempMagpie({ mcp: [foreign] });
  try {
    const fake = fakeMagpie(file);
    await assert.rejects(
      ensureLibraryMcp({ directory }, undefined, { runner: fake.runner, launcher: process.execPath, magpie: '/fake/magpie', entry: BIN_PATH }),
      /插件不会覆盖它/,
    );
    assert.equal(fake.calls.length, 0);
    assert.deepEqual((await readJsonFile(file)).mcp, [foreign]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('多个宿主同时登记时，接受另一个宿主刚写出的相同定义', async () => {
  const { root, directory, file } = await tempMagpie({ mcp: null });
  try {
    const definition = libraryMcpDefinition(process.execPath, BIN_PATH);
    const racing = async () => {
      await fs.writeFile(file, JSON.stringify({ mcp: [{ ...definition, agents: [] }] }));
      throw new Error('magpie 正忙');
    };
    const result = await ensureLibraryMcp({ directory }, undefined, { runner: racing, launcher: process.execPath, magpie: '/fake/magpie', entry: BIN_PATH });
    assert.equal(result.registered, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('卸载时只移除指向当前安装且完全相同的条目', async () => {
  const definition = libraryMcpDefinition(process.execPath, BIN_PATH);
  const { root, directory, file } = await tempMagpie({ mcp: [{ ...definition, agents: [] }] });
  try {
    const fake = fakeMagpie(file);
    assert.equal(await removeLibraryMcp(directory, definition, { runner: fake.runner, magpie: '/fake/magpie' }), true);
    assert.deepEqual((await readJsonFile(file)).mcp, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const other = await tempMagpie({ mcp: [{ ...definition, args: [OLD_LAUNCH, 'mcp'], agents: [] }] });
  try {
    const fake = fakeMagpie(other.file);
    assert.equal(await removeLibraryMcp(other.directory, definition, { runner: fake.runner, magpie: '/fake/magpie' }), false);
    assert.equal(fake.calls.length, 0);
  } finally {
    await fs.rm(other.root, { recursive: true, force: true });
  }
});

test('识别指向本插件入口的条目（含附加参数），但不认领其他程序', () => {
  assert.equal(isOwnEntry({ transport: 'stdio', args: [OLD_LAUNCH, 'mcp'] }), true);
  assert.equal(isOwnEntry({ transport: 'stdio', args: [OLD_LAUNCH, 'mcp', '--config', '/x/options.json'] }), true);
  assert.equal(isOwnEntry({ transport: 'stdio', args: ['/usr/local/bin/other.mjs', 'mcp'] }), false);
  assert.equal(isOwnEntry({ transport: 'http', url: 'https://example.test' }), false);
  const definition = libraryMcpDefinition(process.execPath, BIN_PATH);
  assert.equal(sameDefinition({ ...definition, agents: ['claude'] }, definition), true);
  assert.equal(sameDefinition({ ...definition, args: [OLD_LAUNCH, 'mcp'] }, definition), false);
});

test('资源库账本仍记录本插件时需要继续同步移除', () => {
  assert.equal(pendingMcpRemoval({ applied: { claude: { mcp: [PLUGIN_NAME] } } }), true);
  assert.equal(pendingMcpRemoval({ projects: [{ wrote: { codex: [PLUGIN_NAME] } }] }), true);
  assert.equal(pendingMcpRemoval({ applied: { claude: { mcp: ['other'] } }, mcp: null }), false);
});
