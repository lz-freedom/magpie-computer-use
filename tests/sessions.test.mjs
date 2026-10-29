import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSessionStore } from '../src/sessions.mjs';

test('会话闲置超时或超过数量上限后被丢弃', () => {
  let clock = 0;
  let next = 0;
  const store = createSessionStore({ ttlMs: 100, max: 2, now: () => clock, id: () => `s${++next}` });
  const a = store.create();
  clock = 50;
  const b = store.create();
  store.update(a, { messages: [], lastImage: undefined });
  const c = store.create();
  assert.equal(store.get(b.id), undefined, '最久未用的被挤掉');
  assert.equal(store.get(a.id), a);
  clock = 200;
  assert.equal(store.get(c.id), undefined, '闲置超时');
});

test('证据按会话编号写成文件，编号跨次调用递增；已带编号的沿用', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcu-sessions-'));
  try {
    const store = createSessionStore({ directory, id: () => 'abc' });
    const session = store.create();
    const image = { type: 'image', data: Buffer.from('x').toString('base64'), mimeType: 'image/jpeg' };
    const first = await store.saveEvidence(session, [{ label: '方案 A / 首页', note: '', image }]);
    const second = await store.saveEvidence(session, [{ label: '!!', note: '', image }]);
    assert.equal(first[0].number, 1);
    assert.equal(path.basename(first[0].file), '01-方案-A-首页.jpg');
    assert.equal(path.basename(second[0].file), '02-screen.jpg');
    assert.equal(await fs.readFile(second[0].file, 'utf8'), 'x');
    // 已带编号的截图（执行时告诉过执行模型）沿用原编号，会话编号跟上。
    const numbered = await store.saveEvidence(session, [{ number: 5, label: '截图 #5', image }]);
    assert.equal(path.basename(numbered[0].file), '05-截图-5.jpg');
    assert.equal(session.evidence, 5);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
