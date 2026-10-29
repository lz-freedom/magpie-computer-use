import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appApproval, approvalAnswer, approvalForm, sessionAnswer } from '../src/approval.mjs';

// 原始运行时的应用授权请求：空表单，授权范围放在 _meta.persist 中。
const request = (persist = ['session', 'always']) => ({
  mode: 'form',
  message: 'Allow Computer Use to use "iPhone Mirroring"?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call', tool_params: { app: 'iPhone Mirroring' }, persist },
});

test('识别应用授权请求，并记录运行时提供的授权范围', () => {
  assert.deepEqual(appApproval(request()), { app: 'iPhone Mirroring', message: request().message, session: true, always: true });
  assert.deepEqual(appApproval(request([])), { app: 'iPhone Mirroring', message: request().message, session: false, always: false });
});

test('不是应用授权的请求不处理', () => {
  assert.equal(appApproval({ ...request(), requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }), undefined);
  assert.equal(appApproval({ ...request(), _meta: { connector_id: 'browser' } }), undefined);
  assert.equal(appApproval({ ...request(), mode: 'url' }), undefined);
  assert.equal(appApproval(undefined), undefined);
});

test('手动授权表单：选项用勾选框逐项列出，默认勾选本次会话', () => {
  const form = approvalForm(request(), appApproval(request()));
  assert.match(form.message, /^Allow Computer Use to use "iPhone Mirroring"\?\n/);
  const { session, always } = form.requestedSchema.properties;
  assert.equal(session.type, 'boolean');
  assert.equal(session.default, true);
  assert.equal(always.type, 'boolean');
  assert.equal(always.default, false);
  assert.match(always.title, /lcu apps allow/);
  // 没有单选字段（单选在 Claude Code 中是折叠的）
  assert.ok(Object.values(form.requestedSchema.properties).every(property => !property.enum && !property.oneOf));
  // 运行时只提供会话范围时只有一个勾选框；都不提供时没有字段
  assert.deepEqual(Object.keys(approvalForm(request(['session']), appApproval(request(['session']))).requestedSchema.properties), ['session']);
  assert.deepEqual(approvalForm(request([]), appApproval(request([]))).requestedSchema.properties, {});
});

test('手动授权：勾选结果换回运行时的回答', () => {
  const approval = appApproval(request());
  assert.deepEqual(approvalAnswer(approval, { action: 'accept', content: { session: true, always: false } }), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.deepEqual(approvalAnswer(approval, { action: 'accept', content: { session: true, always: true } }), { action: 'accept', content: {}, _meta: { persist: 'always' } });
  assert.deepEqual(approvalAnswer(approval, { action: 'accept', content: { session: false, always: false } }), { action: 'accept', content: {} });
  assert.deepEqual(approvalAnswer(approval, { action: 'accept' }), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.deepEqual(approvalAnswer(approval, { action: 'decline' }), { action: 'decline' });
  assert.deepEqual(approvalAnswer(approval, { action: 'cancel' }), { action: 'cancel' });
  // 运行时没有提供的范围不会被使用
  assert.deepEqual(approvalAnswer(appApproval(request([])), { action: 'accept', content: { session: true, always: true } }), { action: 'accept', content: {} });
});

test('跟随 Agent 与直接允许：接受即本次会话', () => {
  const approval = appApproval(request());
  assert.deepEqual(sessionAnswer(approval), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.deepEqual(sessionAnswer(approval, { action: 'accept' }), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.deepEqual(sessionAnswer(approval, { action: 'decline' }), { action: 'decline' });
  assert.deepEqual(sessionAnswer(approval, { action: 'cancel' }), { action: 'cancel' });
  assert.deepEqual(sessionAnswer(appApproval(request([]))), { action: 'accept', content: {} });
});
