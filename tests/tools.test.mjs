import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NATIVE_TOOLS, bindingName, buildSteps, validateArguments } from '../src/tools.mjs';

const context = { sessionId: 'session-1', turnId: 'turn-1' };
const BINDING = /__magpieNative_[0-9a-f]{32}/;

test('公开十个工具，名称与参数协议保持不变', () => {
  assert.deepEqual(NATIVE_TOOLS.map(tool => tool.name), [
    'list_apps', 'get_app_state', 'click', 'perform_secondary_action', 'set_value',
    'select_text', 'scroll', 'drag', 'press_key', 'type_text',
  ]);
  for (const tool of NATIVE_TOOLS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test('computer_use 的说明与服务说明都写明简称 mcu', async () => {
  const { DELEGATE_TOOLS, DELEGATE_INSTRUCTIONS } = await import('../src/tools.mjs');
  assert.match(DELEGATE_TOOLS.find(tool => tool.name === 'computer_use').description, /简称 mcu/);
  assert.match(DELEGATE_INSTRUCTIONS, /"mcu"/);
});

test('element_index 同时接受数字字符串与整数，并归一为整数', () => {
  assert.equal(validateArguments('set_value', { app: 'TextEdit', element_index: '3', value: 'x' }).element_index, 3);
  assert.equal(validateArguments('set_value', { app: 'TextEdit', element_index: 4, value: 'x' }).element_index, 4);
  assert.throws(() => validateArguments('set_value', { app: 'TextEdit', element_index: '-1', value: 'x' }), /valid element index/);
  assert.throws(() => validateArguments('set_value', { app: 'TextEdit', element_index: 1.5, value: 'x' }), /valid element index/);
});

test('参数校验：拒绝未知字段、缺失字段、非法枚举与不完整坐标', () => {
  assert.throws(() => validateArguments('type_text', { app: 'TextEdit', text: 'x', extra: 1 }), /Unknown argument: extra/);
  assert.throws(() => validateArguments('type_text', { app: 'TextEdit' }), /Missing text/);
  assert.throws(() => validateArguments('scroll', { app: 'a', element_index: '1', direction: 'diagonal' }), /Invalid direction/);
  assert.throws(() => validateArguments('click', { app: 'a' }), /requires element_index or both x and y/);
  assert.throws(() => validateArguments('click', { app: 'a', element_index: '1', x: 1, y: 2 }), /not both/);
  assert.throws(() => validateArguments('click', { app: 'a', x: 1 }), /requires element_index or both x and y/);
  assert.throws(() => validateArguments('press_key', { app: 'a', key: '  ' }), /nonempty string/);
  assert.throws(() => validateArguments('nope', {}), /Unknown native Computer Use tool/);
  assert.throws(() => validateArguments('list_apps', []), /must be an object/);
});

test('list_apps 使用运行时指定的首次调用 cua.getState()，且不需要应用上下文', () => {
  assert.deepEqual(buildSteps('list_apps', {}, {}), [{ code: 'await cua.getState();', title: '列出应用' }]);
});

test('get_app_state 拆为两次 js 调用：先选择应用，再单独截图', () => {
  const steps = buildSteps('get_app_state', { app: 'Calculator' }, context);
  assert.equal(steps.length, 2);
  const [select, screenshot] = steps;
  assert.match(select.code, /^var __magpieNative_[0-9a-f]{32} = await cua\.getApp\("Calculator"\);$/);
  assert.doesNotMatch(select.code, /getScreenshot/);
  assert.match(screenshot.code, /await __magpieNative_[0-9a-f]{32}\.getScreenshot\(\);$/);
  assert.doesNotMatch(screenshot.code, /var |cua\.getApp/);
});

test('点击按元素索引或截图坐标生成对应的 Target 方法调用，并以界面树作为结果', () => {
  const [byIndex] = buildSteps('click', { app: 'TextEdit', element_index: 3 }, context);
  assert.match(byIndex.code, new RegExp(`await ${BINDING.source}\\.click\\(3, \\{"clickCount":1,"mouseButton":"left"\\}\\);`));
  assert.match(byIndex.code, new RegExp(`await ${BINDING.source}\\.getAXState\\(\\);$`));
  assert.match(byIndex.code, /if \(typeof __magpieNative_[0-9a-f]{32} === 'undefined'\) throw/);

  const [byPoint] = buildSteps('click', { app: 'TextEdit', x: 10, y: 20, click_count: 2, mouse_button: 'right' }, context);
  assert.match(byPoint.code, /\.click\(\[10,20\], \{"clickCount":2,"mouseButton":"right"\}\);/);
});

test('其余动作映射到运行时的对应方法', () => {
  const cases = [
    [{ app: 'a', element_index: '2', action: 'AXPress' }, 'perform_secondary_action', /\.performSecondaryAction\(2, "AXPress"\);/],
    [{ app: 'a', element_index: '2', value: 'hi' }, 'set_value', /\.setValue\(2, "hi"\);/],
    [{ app: 'a', element_index: '2', text: 'ab', selection: 'cursor_after' }, 'select_text', /\.selectText\(2, "ab", \{"selectionType":"cursor_after"\}\);/],
    [{ app: 'a', element_index: '2', direction: 'down', pages: 2 }, 'scroll', /\.scroll\(2, "down", 2\);/],
    [{ app: 'a', from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, 'drag', /\.drag\(\[1,2\], \[3,4\]\);/],
    [{ app: 'a', key: 'super+c' }, 'press_key', /\.pressKey\("super\+c"\);/],
    [{ app: 'a', text: 'Hello' }, 'type_text', /\.typeText\("Hello"\);/],
  ];
  for (const [args, name, expected] of cases) {
    const steps = buildSteps(name, validateArguments(name, args), context);
    assert.equal(steps.length, 1, name);
    assert.match(steps[0].code, expected, name);
    assert.match(steps[0].code, /\.getAXState\(\);$/, name);
  }
});

test('应用名称与输入文字按 JSON 数据编码，不会注入代码', () => {
  const hostile = 'Evil"); process.exit(1); //';
  const [select] = buildSteps('get_app_state', { app: hostile }, context);
  assert.ok(select.code.includes(JSON.stringify(hostile)));
  assert.ok(!select.code.includes(`cua.getApp(${hostile}`));
  const [typed] = buildSteps('type_text', { app: 'a', text: '`${process.exit(1)}`' }, context);
  assert.ok(typed.code.includes(JSON.stringify('`${process.exit(1)}`')));
});

test('需要应用上下文的动作在缺少连接身份时拒绝', () => {
  assert.throws(() => buildSteps('click', { app: 'a', element_index: 1 }, {}), /current connection context/);
});

test('同一连接、同一轮次、同一应用得到相同绑定；其余情况不同', () => {
  const first = bindingName('s', 't', 'TextEdit');
  assert.equal(bindingName('s', 't', 'TextEdit'), first);
  assert.notEqual(bindingName('s', 't', 'Notes'), first);
  assert.notEqual(bindingName('s', 'u', 'TextEdit'), first);
  assert.notEqual(bindingName('r', 't', 'TextEdit'), first);
});
