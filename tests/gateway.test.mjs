import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayError, createGatewayClient, supportsComputerUse } from '../src/gateway.mjs';

function fakeFetch(handler) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const { status = 200, body } = await handler(url, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetch, requests };
}

test('createMessage 以 Anthropic 格式请求 /v1/messages，并带上网关密钥', async () => {
  const { fetch, requests } = fakeFetch(async () => ({ body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }));
  const gateway = createGatewayClient({ url: 'http://127.0.0.1:3425/', key: 'magpie', fetch });
  const response = await gateway.createMessage({ model: 'm', max_tokens: 10, messages: [] });
  assert.equal(response.stop_reason, 'end_turn');
  assert.equal(requests[0].url, 'http://127.0.0.1:3425/v1/messages');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.authorization, 'Bearer magpie');
  assert.equal(requests[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(requests[0].body.model, 'm');
});

test('listModels 读取 /v1/models 的 data 列表', async () => {
  const { fetch } = fakeFetch(async () => ({ body: { data: [{ id: 'a/b' }] } }));
  const gateway = createGatewayClient({ url: 'http://x', key: 'k', fetch });
  assert.deepEqual(await gateway.listModels(), [{ id: 'a/b' }]);
});

test('网关返回错误时抛出 GatewayError，并带上网关给出的原因', async () => {
  const { fetch } = fakeFetch(async () => ({ status: 400, body: { error: { message: 'relay-anthropic: Could not process image' } } }));
  const gateway = createGatewayClient({ url: 'http://x', key: 'k', fetch });
  await assert.rejects(gateway.createMessage({}), error => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 400);
    assert.match(error.message, /Could not process image/);
    return true;
  });
});

test('网关无法连接时提示确认 magpie 是否在运行', async () => {
  const fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const gateway = createGatewayClient({ url: 'http://127.0.0.1:1', key: 'k', fetch });
  await assert.rejects(gateway.listModels(), /ECONNREFUSED.*magpie 正在运行/);
});

test('超时时报告超时，调用方取消时原样抛出取消', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  // AbortSignal.timeout 的计时器不保持事件循环；真实请求的网络连接会保持，这里用一个计时器代替。
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const slow = createGatewayClient({ url: 'http://x', key: 'k', fetch: hang, timeoutMs: 20 });
    await assert.rejects(slow.listModels(), /超时/);
    const controller = new AbortController();
    const pending = createGatewayClient({ url: 'http://x', key: 'k', fetch: hang }).listModels({ signal: controller.signal });
    controller.abort(new Error('cancelled by caller'));
    await assert.rejects(pending, /cancelled by caller/);
  } finally {
    clearInterval(keepAlive);
  }
});

test('supportsComputerUse 需要图片输入与工具调用', () => {
  assert.equal(supportsComputerUse({ modalities: { input: ['text', 'image'] }, tool_call: true }), true);
  assert.equal(supportsComputerUse({ modalities: { input: ['text'] }, tool_call: true }), false);
  assert.equal(supportsComputerUse({ modalities: { input: ['text', 'image'] }, tool_call: false }), false);
  assert.equal(supportsComputerUse({ id: 'unknown' }), undefined);
});

test('请求的 User-Agent 不以 magpie 开头，magpie 会把本插件的请求单独显示为 MCU', async () => {
  const { USER_AGENT } = await import('../src/gateway.mjs');
  assert.match(USER_AGENT, /^MCU\/\d+\.\d+\.\d+ \(magpie-computer-use\)$/);
  const { fetch, requests } = fakeFetch(async () => ({ body: { data: [] } }));
  await createGatewayClient({ url: 'http://x', key: 'k', fetch }).listModels();
  assert.equal(requests[0].init.headers['user-agent'], USER_AGENT);
});
