import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HOOK_MATCHER, decisionFor, installClaudeHook, readMode, recordHookInput, uninstallClaudeHook } from '../src/claude-hook.mjs';

async function withTemp(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcu-hook-'));
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('权限模式对应的处理方式', () => {
  assert.equal(decisionFor('bypassPermissions'), 'allow');
  assert.equal(decisionFor('auto'), 'allow');
  assert.equal(decisionFor('default'), 'ask');
  assert.equal(decisionFor('acceptEdits'), 'ask');
  assert.equal(decisionFor('plan'), 'decline');
  assert.equal(decisionFor('dontAsk'), 'decline');
  assert.equal(decisionFor(null), 'ask');
  assert.equal(decisionFor('something-new'), 'ask');
});

test('钩子记录权限模式，MCP 按 toolUseId 读出；不合法的输入不写文件', async () => withTemp(async directory => {
  const input = JSON.stringify({ session_id: 's1', tool_use_id: 'toolu_abc', permission_mode: 'bypassPermissions', hook_event_name: 'PreToolUse' });
  assert.equal(await recordHookInput(input, { directory }), true);
  assert.equal(await readMode('toolu_abc', { directory }), 'bypassPermissions');
  assert.equal(await readMode('toolu_missing', { directory }), null);
  assert.equal(await recordHookInput('not json', { directory }), false);
  assert.equal(await recordHookInput(JSON.stringify({ tool_use_id: '../escape', permission_mode: 'auto' }), { directory }), false);
  assert.equal(await readMode('../escape', { directory }), null);
  assert.deepEqual(await fs.readdir(directory), ['toolu_abc.json']);
}));

test('一天前的记录会被清理', async () => withTemp(async directory => {
  await recordHookInput(JSON.stringify({ tool_use_id: 'old', permission_mode: 'default' }), { directory });
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await fs.utimes(path.join(directory, 'old.json'), old, old);
  await recordHookInput(JSON.stringify({ tool_use_id: 'new', permission_mode: 'default' }), { directory });
  assert.deepEqual(await fs.readdir(directory), ['new.json']);
}));

test('安装钩子只增改本插件的条目，重复安装不改动；卸载后保留其他钩子', async () => withTemp(async root => {
  const file = path.join(root, 'settings.json');
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other' }] };
  await fs.writeFile(file, JSON.stringify({ model: 'x', hooks: { PreToolUse: [other], Stop: [{ hooks: [] }] } }));
  const command = '"/usr/bin/node" "/p/bin/magpie-computer-use.mjs" claude-hook';
  assert.equal(await installClaudeHook({ file, command }), true);
  let settings = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(settings.model, 'x');
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.deepEqual(settings.hooks.PreToolUse[1], { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command, timeout: 5 }] });
  assert.equal(await installClaudeHook({ file, command }), false);
  // 路径变化时更新为新命令，不会重复添加
  const moved = '"/usr/bin/node" "/q/bin/magpie-computer-use.mjs" claude-hook';
  assert.equal(await installClaudeHook({ file, command: moved }), true);
  settings = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(settings.hooks.PreToolUse.filter(group => group.matcher === HOOK_MATCHER).length, 1);
  assert.equal(settings.hooks.PreToolUse.at(-1).hooks[0].command, moved);
  assert.equal(await uninstallClaudeHook({ file }), true);
  settings = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse, [other]);
  assert.ok(settings.hooks.Stop);
  assert.equal(await uninstallClaudeHook({ file }), false);
}));

test('设置文件不存在时创建；不是 JSON 对象时拒绝改动', async () => withTemp(async root => {
  const file = path.join(root, 'nested', 'settings.json');
  assert.equal(await installClaudeHook({ file, command: 'x claude-hook' }), true);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).hooks.PreToolUse[0].matcher, HOOK_MATCHER);
  const bad = path.join(root, 'bad.json');
  await fs.writeFile(bad, '[]');
  await assert.rejects(installClaudeHook({ file: bad, command: 'x claude-hook' }), /不是 JSON 对象/);
}));
