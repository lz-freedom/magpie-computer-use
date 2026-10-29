/**
 * 评测任务：10 个，从简单到困难。每次运行前 prepare() 生成新的素材与答案（答案随机，不会在三种方式之间泄漏），
 * grade() 按 Agent 最后一行“答案：…”或磁盘上的文件判分，cleanup() 只收拾本任务打开的窗口与文件。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ROOT = '/tmp/mcu-bench';

const osa = script => {
  try { execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 15_000 }); } catch { /* 应用未运行等情况忽略 */ }
};
const quit = app => osa(`if application "${app}" is running then tell application "${app}" to quit`);
const closeSafariBench = () => osa(`if application "Safari" is running then tell application "Safari"
  repeat with w in (every window)
    repeat with t in (every tab of w)
      if (URL of t as text) starts with "file:///tmp/mcu-bench" then close t
    end repeat
  end repeat
end tell`);
const random = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const page = (title, body, script = '') => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px -apple-system,sans-serif;margin:40px;color:#222}button{font-size:16px;padding:8px 18px;border:0;border-radius:6px;color:#fff;cursor:pointer}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 12px}input,select{font-size:16px;padding:4px}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
const write = async (name, text) => fs.writeFile(path.join(ROOT, name), text);

/** 从 Agent 的最终回复中取出最后一个“答案：…”。 */
export function answerOf(text = '') {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = /答案\s*[:：]\s*(.+)$/.exec(lines[index].replace(/[*`]/g, ''));
    if (match) return match[1].trim();
  }
  return '';
}
const has = (answer, expected) => answer.replace(/[\s,，]/g, '').includes(String(expected));

// 确认码：页面与判分用同一算法。
export function confirmation(name, city) {
  let sum = 0;
  for (const char of `${name}|${city}`) sum = (sum * 31 + char.codePointAt(0)) % 900_000;
  return `C${100_000 + sum}`;
}

export const TASKS = [
  {
    id: 't01', level: '简单', title: '计算器：乘法',
    prompt: () => '用计算器（Calculator）计算 12 × 34，告诉我结果。',
    expected: () => '408',
    grade: answer => has(answer, '408'),
    cleanup: () => quit('Calculator'),
  },
  {
    id: 't02', level: '简单', title: '计算器：四则运算',
    prompt: () => '用计算器（Calculator）计算 (125 + 375) ÷ 4，告诉我结果。',
    expected: () => '125',
    grade: answer => /(^|[^0-9])125([^0-9]|$)/.test(answer.replace(/\s/g, '')),
    cleanup: () => quit('Calculator'),
  },
  {
    id: 't03', level: '简单', title: '系统设置：读取 macOS 版本',
    prompt: () => '打开“系统设置 → 通用 → 关于本机”，告诉我这台 Mac 的 macOS 版本号（例如 15.1）。只读，不要修改任何设置。',
    expected: () => execFileSync('sw_vers', ['-productVersion']).toString().trim(),
    grade: (answer, expected) => has(answer, expected),
    cleanup: () => quit('System Settings'),
  },
  {
    id: 't04', level: '较易', title: 'Safari：读取页面上的订单号',
    async prepare(state) {
      state.code = `MCU-${random(10000, 99999)}`;
      await write('t04.html', page('订单详情', `<h1>订单详情</h1><p>收货人：李雷</p><p>订单号：<b>${state.code}</b></p><p>金额：¥128.00</p>`));
    },
    prompt: () => '用 Safari 打开 file:///tmp/mcu-bench/t04.html，告诉我页面上的订单号。',
    expected: state => state.code,
    grade: (answer, expected) => answer.includes(expected),
    cleanup: closeSafariBench,
  },
  {
    id: 't05', level: '较易', title: '访达：统计文件',
    async prepare(state) {
      const folder = path.join(ROOT, 't05');
      await fs.rm(folder, { recursive: true, force: true });
      await fs.mkdir(folder);
      state.count = random(3, 6);
      const names = [...Array.from({ length: state.count }, (_, i) => `笔记${i + 1}.txt`), '封面.png', '图标.png', '说明.md'];
      for (const name of names) await fs.writeFile(path.join(folder, name), name);
    },
    prompt: () => '用访达（Finder）打开文件夹 /tmp/mcu-bench/t05，告诉我里面有几个 .txt 文件。',
    expected: state => String(state.count),
    grade: (answer, expected) => new RegExp(`(^|[^0-9])${expected}([^0-9]|$)`).test(answer),
    cleanup: () => osa(`tell application "Finder" to close (every window whose name is "t05")`),
  },
  {
    id: 't06', level: '中等', title: 'Safari：填写并提交表单',
    async prepare(state) {
      state.code = confirmation('张三', '上海');
      await write('t06.html', page('预约', `<h1>预约登记</h1>
<p><label>姓名 <input id="name"></label></p>
<p><label>城市 <select id="city"><option value="">请选择</option><option>北京</option><option>上海</option><option>广州</option></select></label></p>
<p><button id="go" style="background:#2563eb">提交</button></p><p id="out"></p>`, `
function code(name, city){let s=0;for(const c of name+'|'+city)s=(s*31+c.codePointAt(0))%900000;return 'C'+(100000+s)}
document.getElementById('go').onclick=()=>{const n=document.getElementById('name').value.trim(),c=document.getElementById('city').value;
document.getElementById('out').textContent=n&&c?'提交成功，确认码：'+code(n,c):'请填写姓名并选择城市';};`));
    },
    prompt: () => '用 Safari 打开 file:///tmp/mcu-bench/t06.html，姓名填“张三”，城市选“上海”，点“提交”，告诉我页面显示的确认码。',
    expected: state => state.code,
    grade: (answer, expected) => answer.includes(expected),
    cleanup: closeSafariBench,
  },
  {
    id: 't07', level: '中等', title: '计算器：科学计算',
    prompt: () => '用计算器（Calculator）的科学计算功能计算 2 的 10 次方加上 144 的平方根，告诉我结果。',
    expected: () => '1036',
    grade: answer => has(answer, '1036'),
    cleanup: () => quit('Calculator'),
  },
  {
    id: 't08', level: '较难', title: 'Safari：对比两个页面',
    async prepare(state) {
      state.red = Math.random() < 0.5 ? 'A' : 'B';
      const make = side => page(`方案 ${side}`, `<h1>方案 ${side}</h1><p>智能手表 · ¥${side === 'A' ? 299 : 259}</p>
<button style="background:${side === state.red ? '#dc2626' : '#16a34a'}">立即购买</button>`);
      await write('t08a.html', make('A'));
      await write('t08b.html', make('B'));
    },
    prompt: () => '用 Safari 分别打开 file:///tmp/mcu-bench/t08a.html（方案 A）和 file:///tmp/mcu-bench/t08b.html（方案 B），看两个页面的“立即购买”按钮，告诉我哪个方案的按钮是红色的。答案只写 A 或 B。',
    expected: state => state.red,
    grade: (answer, expected) => answer.replace(/方案/g, '').trim().toUpperCase().startsWith(expected),
    cleanup: closeSafariBench,
  },
  {
    id: 't09', level: '较难', title: '文本编辑：新建并保存纯文本文件',
    async prepare(state) {
      state.text = `MCU benchmark ${random(100, 999)}`;
      await fs.rm(path.join(ROOT, 't09.txt'), { force: true });
    },
    prompt: state => `用“文本编辑”（TextEdit）新建一个纯文本文档，内容是“${state.text}”，保存到 /tmp/mcu-bench/t09.txt。完成后告诉我保存的路径。`,
    expected: state => state.text,
    async grade(_answer, expected) {
      const text = await fs.readFile(path.join(ROOT, 't09.txt'), 'utf8').catch(() => null);
      return text !== null && text.trim() === expected;
    },
    cleanup: () => osa(`if application "TextEdit" is running then tell application "TextEdit"
  close (every document whose (path is missing value) or (path contains "mcu-bench")) saving no
end tell`),
  },
  {
    id: 't10', level: '困难', title: 'Safari：分页表格找最大值',
    async prepare(state) {
      const rows = Array.from({ length: 30 }, (_, i) => ({ sku: `SKU-${String(random(1000, 9999))}${String.fromCharCode(65 + (i % 26))}`, price: random(100, 900) }));
      const top = random(0, 29);
      rows[top].price = 999;
      state.sku = rows[top].sku;
      await write('t10.html', page('商品列表', `<h1>商品列表</h1><table><thead><tr><th>SKU</th><th>价格</th></tr></thead><tbody id="rows"></tbody></table>
<p><button id="prev" style="background:#475569">上一页</button> <span id="info"></span> <button id="next" style="background:#475569">下一页</button></p>`, `
const rows=${JSON.stringify(rows)};let p=0;function draw(){document.getElementById('rows').innerHTML=rows.slice(p*10,p*10+10).map(r=>'<tr><td>'+r.sku+'</td><td>¥'+r.price+'</td></tr>').join('');
document.getElementById('info').textContent='第 '+(p+1)+' / 3 页';}
document.getElementById('prev').onclick=()=>{if(p>0){p--;draw();}};document.getElementById('next').onclick=()=>{if(p<2){p++;draw();}};draw();`));
    },
    prompt: () => '用 Safari 打开 file:///tmp/mcu-bench/t10.html。表格分 3 页显示（用“下一页”翻页），找出全部商品里价格最高的那个，告诉我它的 SKU。',
    expected: state => state.sku,
    grade: (answer, expected) => answer.toUpperCase().includes(expected.toUpperCase()),
    cleanup: closeSafariBench,
  },
];

export async function prepareRoot() {
  await fs.mkdir(ROOT, { recursive: true });
}

// iPhone 镜像任务：通过 Mac 上的“iPhone 镜像”操作手机（手机需锁屏，镜像才能连接）。
// 公平性：iPhone 镜像无法划掉后台 App，所以每次运行的内容都不同（随机数字、随机页面、没搜过的中文词），
// 上一次留下的界面对下一次没有帮助；三种方式的先后顺序由 run.mjs 按任务轮换。任务之间回到主屏幕。
// 网页类任务由 Mac 上的测试服务器提供（同一局域网），可自动判分；京东类任务记录回答与截图，人工核对。
// 回到主屏幕：由 run.mjs 通过运行时给 iPhone 镜像发 ⌘1（不经过模型，也不会把按键发给其他应用）。
const home = (_state, context) => context?.home?.();
const token = () => Math.random().toString(36).slice(2, 7);
const code4 = () => String(random(1000, 9999));
const mobilePage = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:18px -apple-system,sans-serif;margin:16px;color:#222}li{padding:14px 4px;border-bottom:1px solid #ddd;list-style:none}ul{padding:0}.red{color:#dc2626;font-weight:600}</style></head><body>${body}</body></html>`;
const QUERIES = ['降噪蓝牙耳机', '机械键盘茶轴', '保温杯大容量', '恐龙儿童绘本', '家用空气炸锅', '加厚瑜伽垫', '声波电动牙刷', '登山双肩包', '意式咖啡豆', '学生护眼台灯', '无线充电宝', '桌面收纳盒'];
const usedQueries = new Set();
const freshQuery = () => {
  const left = QUERIES.filter(query => !usedQueries.has(query));
  const query = left[random(0, left.length - 1)];
  usedQueries.add(query);
  return query;
};
const VIA = '通过 Mac 上的“iPhone 镜像”（iPhone Mirroring）操作我的 iPhone：';

export const IPHONE_TASKS = [
  {
    id: 'i01', level: '简单', title: 'iPhone 计算器：乘法（随机数）',
    async prepare(state) { state.a = random(12, 98); state.b = random(12, 98); },
    prompt: state => `${VIA}打开 iPhone 上的计算器，计算 ${state.a} × ${state.b}，告诉我结果。`,
    expected: state => String(state.a * state.b),
    grade: (answer, expected) => has(answer, expected),
    cleanup: home,
  },
  {
    id: 'i02', level: '中等', title: 'iPhone 计算器：科学计算（随机数）',
    async prepare(state) { state.n = random(8, 12); state.m = random(11, 19); },
    prompt: state => `${VIA}用 iPhone 计算器的科学计算功能，计算 2 的 ${state.n} 次方加上 ${state.m * state.m} 的平方根，告诉我结果。`,
    expected: state => String(2 ** state.n + state.m),
    grade: (answer, expected) => has(answer, expected),
    cleanup: home,
  },
  {
    id: 'i03', level: '中等', title: '滑动：长页面读页尾验证码',
    async prepare(state, { server }) {
      state.code = code4();
      const filler = Array.from({ length: 60 }, (_, i) => `<p>第 ${i + 1} 段：这是一段用来占位的说明文字，内容和任务无关，请继续往下滑。</p>`).join('');
      state.url = server.add(`/p/${token()}`, mobilePage('长页面', `<h2>长页面</h2>${filler}<footer><p>页尾验证码：<b>${state.code}</b></p></footer>`));
    },
    prompt: state => `${VIA}用 iPhone 上的 Safari 打开 ${state.url}，一直往下滑到页面最底部，告诉我页尾的验证码。`,
    expected: state => state.code,
    grade: (answer, expected) => has(answer, expected),
    cleanup: home,
  },
  {
    id: 'i04', level: '较难', title: '滑动：长列表找第 N 项',
    async prepare(state, { server }) {
      state.index = random(41, 75);
      const codes = Array.from({ length: 80 }, () => code4());
      state.code = codes[state.index - 1];
      const items = codes.map((code, i) => `<li>第 ${i + 1} 项 · 代码 ${code}</li>`).join('');
      state.url = server.add(`/l/${token()}`, mobilePage('列表', `<h2>商品编号列表</h2><ul>${items}</ul>`));
    },
    prompt: state => `${VIA}用 iPhone 上的 Safari 打开 ${state.url}，往下滑找到“第 ${state.index} 项”，告诉我它的代码。`,
    expected: state => state.code,
    grade: (answer, expected) => has(answer, expected),
    cleanup: home,
  },
  {
    id: 'i05', level: '较难', title: '滑动：长列表找唯一标红的一项',
    async prepare(state, { server }) {
      const red = random(35, 70);
      const codes = Array.from({ length: 80 }, () => code4());
      state.code = codes[red - 1];
      const items = codes.map((code, i) => `<li${i === red - 1 ? ' class="red"' : ''}>第 ${i + 1} 项 · 代码 ${code}</li>`).join('');
      state.url = server.add(`/r/${token()}`, mobilePage('列表', `<h2>库存列表</h2><p>列表中只有一项是红色文字。</p><ul>${items}</ul>`));
    },
    prompt: state => `${VIA}用 iPhone 上的 Safari 打开 ${state.url}，往下滑找到列表里唯一一项红色文字，告诉我它的代码。`,
    expected: state => state.code,
    grade: (answer, expected) => has(answer, expected),
    cleanup: home,
  },
  {
    id: 'i06', level: '较难', title: '京东：搜索（中文）并读第一个结果',
    async prepare(state) { state.query = freshQuery(); },
    prompt: state => `${VIA}打开京东 App，搜索“${state.query}”，告诉我搜索结果里第一个商品的标题和价格（广告位也算）。只看，不要加购物车或下单。答案写成“标题｜价格”。`,
    expected: state => `（人工核对：${state.query}）`,
    grade: answer => /\d/.test(answer) && answer.includes('｜'),
    manual: true,
    cleanup: home,
  },
  {
    id: 'i07', level: '困难', title: '京东：搜索后按价格升序读第一个',
    async prepare(state) { state.query = freshQuery(); },
    prompt: state => `${VIA}打开京东 App，搜索“${state.query}”，把结果按价格从低到高排序，告诉我排第一的商品的标题和价格。只看，不要加购物车或下单。答案写成“标题｜价格”。`,
    expected: state => `（人工核对：${state.query}）`,
    grade: answer => /\d/.test(answer) && answer.includes('｜'),
    manual: true,
    cleanup: home,
  },
  {
    id: 'i08', level: '困难', title: '京东：搜索后往下滑读第 6 个商品',
    async prepare(state) { state.query = freshQuery(); },
    prompt: state => `${VIA}打开京东 App，搜索“${state.query}”，在搜索结果里往下滑，从上往下数第 6 个商品（广告位也算），告诉我它的标题和价格。只看，不要加购物车或下单。答案写成“标题｜价格”。`,
    expected: state => `（人工核对：${state.query}）`,
    grade: answer => /\d/.test(answer) && answer.includes('｜'),
    manual: true,
    cleanup: home,
  },
];

/** iPhone 网页任务用的测试服务器：监听局域网地址，按路径返回生成的页面。 */
export async function startFixtureServer({ host, port = 8765 } = {}) {
  const http = await import('node:http');
  const { networkInterfaces } = await import('node:os');
  const address = host ?? Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal && item.address.startsWith('192.168.'))?.address;
  if (!address) throw new Error('找不到局域网 IPv4 地址，iPhone 无法访问测试页面');
  const pages = new Map();
  const server = http.createServer((request, response) => {
    const html = pages.get(request.url.split('?')[0]);
    response.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html ?? 'not found');
  });
  await new Promise((resolve, reject) => server.listen(port, '0.0.0.0', resolve).on('error', reject));
  return {
    add(path, html) { pages.set(path, html); return `http://${address}:${port}${path}`; },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

// 加测任务：真实应用、真实账号，结果人工核对（最后一张截图与完整回复）。收尾动作（关闭应用、退出登录）计入耗时。
// 登录任务的地址与账号来自环境变量 MCU_BENCH_LOGIN_URL、MCU_BENCH_LOGIN_ACCOUNT（验证码从企业微信获取），未设置时跳过。
const LOGIN_URL = process.env.MCU_BENCH_LOGIN_URL ?? '';
const LOGIN_ACCOUNT = process.env.MCU_BENCH_LOGIN_ACCOUNT ?? '';
const LOGIN_HOST = (() => { try { return new URL(LOGIN_URL).host; } catch { return ''; } })();
// 只关任务期间新开的登录站点标签页，用户原本开着的标签页不动。
const chromeTabIds = () => {
  try {
    return execFileSync('osascript', ['-e', 'if application "Google Chrome" is running then tell application "Google Chrome" to get id of every tab of every window'], { timeout: 15_000 })
      .toString().split(/[,\s]+/).filter(Boolean);
  } catch { return []; }
};
const closeNewConsoleTabs = state => {
  if (!LOGIN_HOST) return;
  const before = (state.tabsBefore ?? []).join(',');
  osa(`if application "Google Chrome" is running then tell application "Google Chrome"
  set keep to "," & "${before}" & ","
  repeat with w in (every window)
    repeat with t in (every tab of w)
      if (URL of t as text) contains "${LOGIN_HOST}" and keep does not contain ("," & ((id of t) as text) & ",") then close t
    end repeat
  end repeat
end tell`);
};

// 酒店任务的入住日期，可用环境变量 MCU_BENCH_HOTEL_DATES="11-18,11-19" 改。
const [checkIn, checkOut] = (process.env.MCU_BENCH_HOTEL_DATES ?? '11-05,11-06').split(',').map(day => day.split('-').map(Number));
const HOTEL_DATES = {
  label: `${checkIn[0]} 月 ${checkIn[1]} 日入住、${checkOut[0]} 月 ${checkOut[1]} 日离店`,
  short: `${checkIn[0]}.${String(checkIn[1]).padStart(2, '0')}–${checkOut[0]}.${String(checkOut[1]).padStart(2, '0')}`,
};

// 无痕窗口：只关任务期间新开的无痕窗口，用户原本开着的窗口不动。
const chromeIncognitoIds = () => {
  try {
    return execFileSync('osascript', ['-e', 'if application "Google Chrome" is running then tell application "Google Chrome" to get id of (every window whose mode is "incognito")'], { timeout: 15_000 })
      .toString().split(/[,\s]+/).filter(Boolean);
  } catch { return []; }
};
const closeNewIncognito = state => {
  const before = (state.incognitoBefore ?? []).join(',');
  osa(`if application "Google Chrome" is running then tell application "Google Chrome"
  set keep to "," & "${before}" & ","
  repeat with w in (every window whose mode is "incognito")
    if keep does not contain ("," & ((id of w) as text) & ",") then close w
  end repeat
end tell`);
};
const [mCheckIn, mCheckOut] = (process.env.MCU_BENCH_MARRIOTT_DATES ?? '11-25,11-26').split(',').map(day => day.split('-').map(Number));

export const EXTRA_TASKS = [
  {
    id: 'x01', level: '困难', title: `iPhone：美团与携程查上海丽思卡尔顿 ${HOTEL_DATES.short} 全部价格方案，并划掉两个 App`,
    prompt: () => `${VIA}分别打开美团和携程，查看“上海丽思卡尔顿”酒店 ${HOTEL_DATES.label}的所有价格方案（房型、早餐/取消政策等条件、价格），两个平台都要看全。只查看，不要预订、不要下单。查完后在 App 切换器里把美团和携程都划掉关闭。
最后先按平台列出全部价格方案，再写一行“答案：美团 N 个方案，携程 M 个方案，两个 App 已关闭/未能关闭”。`,
    expected: () => '（人工核对）',
    grade: answer => /美团/.test(answer) && /携程/.test(answer),
    manual: true,
    cleanup: home,
  },
  {
    id: 'x02', level: '困难', title: 'Chrome：用企业微信里的验证码登录控制台，再退出登录',
    skip: LOGIN_URL && LOGIN_ACCOUNT ? null : '未设置 MCU_BENCH_LOGIN_URL / MCU_BENCH_LOGIN_ACCOUNT',
    prompt: () => `用 Mac 上的 Chrome 打开 ${LOGIN_URL} 并登录：账号 ${LOGIN_ACCOUNT}，验证码从我的企业微信（Mac 上的“企业微信”应用）里获取。登录成功后确认看到控制台页面，然后退出登录。
最后写一行“答案：登录成功并已退出 / 失败原因”。`,
    async prepare(state) { state.tabsBefore = chromeTabIds(); },
    expected: () => '登录成功并已退出',
    grade: answer => /成功/.test(answer) && /退出/.test(answer) && !/失败|未能|没有成功/.test(answer),
    manual: true,
    cleanup: closeNewConsoleTabs,
  },
  {
    id: 'x03', level: '困难', title: `Chrome 无痕：万豪官网查上海浦东丽思卡尔顿 ${mCheckIn[0]}.${mCheckIn[1]}–${mCheckOut[0]}.${mCheckOut[1]} 全部价格方案`,
    async prepare(state) { state.incognitoBefore = chromeIncognitoIds(); },
    prompt: () => `用 Mac 上的 Chrome 打开一个无痕窗口，访问 https://www.marriott.com.cn/ ，查询“上海浦东丽思卡尔顿酒店”${mCheckIn[0]} 月 ${mCheckIn[1]} 日入住、${mCheckOut[0]} 月 ${mCheckOut[1]} 日离店（1 间、2 位成人）的所有价格方案（房型、价格方案名称、早餐/取消政策等条件、价格），全部列出。只查看，不要登录、不要预订。
最后先列出全部价格方案，再写一行“答案：共 N 个价格方案，最低 ¥X”。`,
    expected: () => '（人工核对）',
    grade: answer => /\d/.test(answer) && /方案/.test(answer),
    manual: true,
    cleanup: closeNewIncognito,
  },
];
