'use strict';
/**
 * Computer Use 设置页。通过 magpie 的页面桥（_magpie/bridge.js）读写本插件的选项，
 * 与 `magpie plugin options magpie-computer-use` 写入的是同一份选项。模型清单来自插件加载时生成的 models.js。
 * 修改即时保存，与 magpie 自身的设置一致；模型选择器沿用 magpie 的选择器：搜索、提供方侧栏、分组与徽标。
 */
(() => {
  const DEFAULTS = Object.freeze({ tools: 'both', approval: 'manual', executorEffort: 'medium', chrome: false, maxSteps: 40, evidenceImages: 4 });
  const TOOL_MODES = ['both', 'delegate', 'direct'];
  const APPROVAL_MODES = ['manual', 'agent', 'auto'];
  const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
  const LIMITS = Object.freeze({ maxSteps: [1, 200], evidenceImages: [0, 10] });
  // 早期版本的选项，已不再使用；保存时从选项中去掉。
  const RETIRED = ['executor', 'keepScreenshots', 'executorApi'];
  const MODEL_PATTERN = /^[^\s/]+\/\S+$/;
  // magpie 的 options.set 每秒最多一次；连续修改合并为一次保存。
  const SAVE_DELAY_MS = 350;
  const SAVE_GAP_MS = 1050;

  const SVG = {
    check: '<svg class="check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    all: '<svg class="ic glyph" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="9" width="4.5" height="4.5" rx="1.2"/></g></svg>',
    route: '<svg class="ic glyph" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="3.5" cy="8" r="1.6"/><circle cx="12.5" cy="3.5" r="1.6"/><circle cx="12.5" cy="12.5" r="1.6"/><path d="M5 7.3c2.5-1 3.5-3 6-3.5M5 8.7c2.5 1 3.5 3 6 3.5"/></g></svg>',
    unset: '<svg class="ic glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.2 2"/></svg>',
    custom: '<svg class="ic glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  /* ---- 纯函数（也供测试使用） ---------------------------------------------- */

  /** 上下文长度徽标：与 magpie 一致，只给 100 万以上的长上下文标出，例如 1M。 */
  function contextBadge(tokens) {
    if (!Number.isFinite(tokens) || tokens < 1_000_000) return null;
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }

  /** 选择器的行：未设置、手动输入、按提供方分组的模型。query 按空格分词，每个词都要命中名称、ID 或提供方。 */
  function pickerRows(catalog, { query = '', provider = null } = {}) {
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const providers = new Map((catalog?.providers ?? []).map(item => [item.id, item]));
    const text = query.trim();
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = [];
    if (!terms.length && !provider) rows.push({ type: 'reset' });
    if (text && MODEL_PATTERN.test(text) && !models.some(model => model.id === text)) rows.push({ type: 'custom', id: text });
    // 按提供方分组，提供方按首次出现的顺序排列，组内保持网关给出的顺序。
    const groups = new Map();
    for (const model of models) {
      if (provider && model.provider !== provider) continue;
      const label = providers.get(model.provider)?.label ?? model.provider;
      const haystack = `${model.name} ${model.id} ${label}`.toLowerCase();
      if (!terms.every(term => haystack.includes(term))) continue;
      if (!groups.has(model.provider)) groups.set(model.provider, { label, models: [] });
      groups.get(model.provider).models.push(model);
    }
    for (const [id, group] of groups) {
      rows.push({ type: 'group', provider: id, label: group.label });
      for (const model of group.models) rows.push({ type: 'model', model, providerLabel: group.label });
    }
    return rows;
  }

  /** 选项 → 表单状态。未知或不合法的值回落到默认值，避免页面无法打开。 */
  function formState(options) {
    const raw = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    const integer = (value, [min, max], fallback) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);
    return {
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null,
      tools: TOOL_MODES.includes(raw.tools) ? raw.tools : DEFAULTS.tools,
      approval: APPROVAL_MODES.includes(raw.approval) ? raw.approval : DEFAULTS.approval,
      executorEffort: EFFORTS.includes(raw.executorEffort) ? raw.executorEffort : DEFAULTS.executorEffort,
      chrome: typeof raw.chrome === 'boolean' ? raw.chrome : DEFAULTS.chrome,
      maxSteps: integer(raw.maxSteps, LIMITS.maxSteps, DEFAULTS.maxSteps),
      evidenceImages: integer(raw.evidenceImages, LIMITS.evidenceImages, DEFAULTS.evidenceImages),
    };
  }

  /** 校验表单状态，返回 { values } 或 { field, message }。范围与插件的 options.mjs 一致。 */
  function validate({ model, tools, approval = DEFAULTS.approval, executorEffort = DEFAULTS.executorEffort, chrome = DEFAULTS.chrome, maxSteps, evidenceImages = DEFAULTS.evidenceImages }) {
    if (model && !MODEL_PATTERN.test(model)) return { field: 'model', message: '模型 ID 应为 provider/model 的形式。' };
    if (!TOOL_MODES.includes(tools)) return { field: 'tools', message: '请选择提供给 Agent 的工具。' };
    if (!APPROVAL_MODES.includes(approval)) return { field: 'approval', message: '请选择应用授权方式。' };
    if (!EFFORTS.includes(executorEffort)) return { field: 'executorEffort', message: '请选择推理强度。' };
    const steps = Number(maxSteps);
    if (!Number.isInteger(steps) || steps < LIMITS.maxSteps[0] || steps > LIMITS.maxSteps[1]) return { field: 'maxSteps', message: '最多步数应为 1–200 的整数。' };
    const images = Number(evidenceImages);
    if (!Number.isInteger(images) || images < LIMITS.evidenceImages[0] || images > LIMITS.evidenceImages[1]) return { field: 'evidenceImages', message: '回传截图应为 0–10 的整数。' };
    return { values: { model: model || null, tools, approval, executorEffort, chrome: Boolean(chrome), maxSteps: steps, evidenceImages: images } };
  }

  /** 在最新选项上合并本页管理的字段，其余字段（例如 gatewayUrl）原样保留；未设置模型时去掉 model。 */
  function mergeOptions(latest, values) {
    const merged = latest && typeof latest === 'object' && !Array.isArray(latest) ? { ...latest } : {};
    if (values.model) merged.model = values.model; else delete merged.model;
    merged.tools = values.tools;
    if (values.approval) merged.approval = values.approval;
    if (values.executorEffort) merged.executorEffort = values.executorEffort;
    if (values.chrome !== undefined) merged.chrome = values.chrome;
    merged.maxSteps = values.maxSteps;
    for (const key of RETIRED) delete merged[key];
    if (values.evidenceImages !== undefined) merged.evidenceImages = values.evidenceImages;
    return merged;
  }

  // 检测：保存选项会让 magpie 重新加载插件，插件随即检测浏览器状态并重写 models.js；等它比请求新时刷新显示。
  const CHECK_TIMEOUT_MS = 45_000;
  const CHECK_POLL_MS = 1_000;

  const EXTENSION_URL = 'https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg';

  /**
   * 浏览器状态 → 检查项 [{ label, level: ok|todo|warn, value, hint?, link? }]。
   * 状态来自插件加载时的检测（lcu browser status）。
   */
  function browserChecks(browser) {
    if (!browser) return [{ label: '状态', level: 'warn', value: '还没有检测结果', hint: '点“重新检测”。' }];
    if (browser.error) return [{ label: '状态', level: 'warn', value: '无法检测', hint: browser.error }];
    const connector = browser.connector === 'lcu'
      ? { label: '连接器', level: 'ok', value: '已指向 LCU', hint: browser.installed ? '刚刚配置：请重启 Chrome，或在 chrome://extensions 把 ChatGPT 扩展关掉再打开。' : undefined }
      : { label: '连接器', level: 'todo', value: '还没指向 LCU', hint: '下一次调用时会自动运行 lcu browser install。' };
    const store = { text: 'Chrome 应用商店', url: EXTENSION_URL };
    const extension = browser.extension === 'enabled' ? { label: 'ChatGPT 扩展', level: 'ok', value: '已启用' }
      : browser.extension === 'missing' ? { label: 'ChatGPT 扩展', level: 'todo', value: '没有安装或没有启用', hint: '从这里安装：', link: store }
        : { label: 'ChatGPT 扩展', level: 'warn', value: '无法确认', hint: 'macOS 不允许读取 Chrome 的配置。请确认已安装并启用；没有的话从这里安装：', link: store };
    return [connector, extension];
  }

  function catalogNote(catalog) {
    if (!catalog) return '模型列表尚未生成；可在选择器中直接输入模型 ID';
    if (catalog.error) return `读取模型列表失败：${catalog.error}。可在选择器中直接输入模型 ID`;
    const time = new Date(catalog.generatedAt);
    const pad = value => String(value).padStart(2, '0');
    const when = Number.isNaN(time.getTime()) ? '' : ` · ${pad(time.getMonth() + 1)}/${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())} 更新`;
    return `${catalog.models.length} 个可用模型（来自 magpie 网关）${when}`;
  }

  /* ---- 页面 ---------------------------------------------------------------- */

  async function mount({ document, magpie, catalog }) {
    const $ = id => document.getElementById(id);
    const window = document.defaultView;
    const field = $('model-field');
    const picker = $('picker');
    const input = $('picker-input');
    const rail = $('picker-rail');
    const list = $('picker-list');
    const tip = $('rail-tip');
    const status = $('status');
    const banner = $('page-error');
    const steppers = [...document.querySelectorAll('.stepper')];
    const executorSection = $('executor-section');
    const chromeSwitch = $('chrome-switch');
    const chromeStatus = $('chrome-status');
    const chromeChecks = $('chrome-checks');
    const chromeCheck = $('chrome-check');
    const chromeChecked = $('chrome-checked');
    let browser = catalog?.browser;
    let checkedAt = catalog?.generatedAt;
    // 正在检测时为请求时间；检测超时时为 'timeout'。
    let checking = null;
    let checkRequest = null;
    const choices = [...document.querySelectorAll('.choice')];
    const fieldOf = choice => choice.closest('[data-field]').dataset.field;
    const providers = new Map((catalog?.providers ?? []).map(item => [item.id, item]));
    const models = new Map((catalog?.models ?? []).map(item => [item.id, item]));
    let state = formState({});
    let ready = false;

    const html = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const fromSvg = markup => {
      const box = document.createElement('span');
      box.innerHTML = markup;
      return box.firstElementChild;
    };

    // 提供方图标：彩色用图片，单色用遮罩跟随文字颜色；没有图标时路由组用路由图形，其余用首字母。
    function iconOf(providerId) {
      const item = providers.get(providerId);
      if (item?.icon?.mono) {
        const node = html('span', 'ic mono');
        node.style.setProperty('--src', `url("${item.icon.src}")`);
        return node;
      }
      if (item?.icon?.src) {
        const node = html('img', 'ic');
        node.src = item.icon.src;
        node.alt = '';
        return node;
      }
      if (providerId === 'auto') return fromSvg(SVG.route);
      return html('span', 'ic letter', (item?.label || providerId || '?').slice(0, 1).toUpperCase());
    }

    function setStatus(text, kind = '') {
      status.textContent = text;
      status.className = `status${kind ? ` ${kind}` : ''}`;
    }

    /* ---- 绘制当前状态 ---- */

    function paintField() {
      const slot = field.querySelector('.ic-slot');
      const value = field.querySelector('.field-v');
      const model = state.model ? models.get(state.model) : null;
      slot.replaceChildren(state.model ? (model ? iconOf(model.provider) : fromSvg(SVG.custom)) : fromSvg(SVG.unset));
      value.textContent = state.model ? (model?.name ?? state.model) : '未设置';
      value.classList.toggle('unset', !state.model);
      field.title = state.model ?? '未设置：Agent 调用 computer_use 时必须指定 model';
    }

    function paint() {
      paintField();
      for (const stepper of steppers) stepper.querySelector('input').value = String(state[stepper.dataset.field]);
      for (const choice of choices) choice.setAttribute('aria-checked', String(choice.dataset.value === state[fieldOf(choice)]));
      // 只用直接操作时不经过执行模型，它的设置收起来。
      executorSection.hidden = state.tools === 'direct';
      chromeSwitch.setAttribute('aria-checked', String(state.chrome));
      chromeStatus.hidden = !state.chrome;
      chromeChecks.replaceChildren(...browserChecks(browser).map(checkRow));
      chromeChecks.classList.toggle('stale', typeof checking === 'number');
      const time = browser && checkedAt ? new Date(checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      chromeChecked.className = `checked${checking === 'timeout' ? ' warn' : ''}`;
      chromeChecked.textContent = typeof checking === 'number' ? '正在检测，约 15 秒…'
        : checking === 'timeout' ? '检测超时：magpie 没有重新加载插件，稍后再试' : time ? `检测于 ${time}` : '';
      chromeCheck.disabled = !ready || typeof checking === 'number';
      chromeCheck.textContent = typeof checking === 'number' ? '检测中…' : '重新检测';
    }

    function checkRow(check) {
      const row = html('div', `check ${check.level}`);
      row.append(html('span', 'check-label', check.label));
      const body = html('div', 'check-body');
      body.append(html('span', 'check-value', check.value));
      if (check.hint || check.link) {
        const hint = html('span', 'check-hint', check.hint ?? '');
        if (check.link) {
          const link = html('a', '', check.link.text);
          link.href = check.link.url;
          link.target = '_blank';
          link.rel = 'noreferrer';
          hint.append(link);
        }
        body.append(hint);
      }
      row.append(body);
      return row;
    }

    /* ---- 保存：合并连续修改，遵守每秒一次的限制 ---- */

    let timer = null;
    let saving = null;
    let lastSaved = 0;
    function scheduleSave() {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void save(); }, SAVE_DELAY_MS);
      setStatus('正在保存…');
    }
    async function save() {
      if (saving) { await saving; if (!timer) scheduleSave(); return; }
      const checked = validate(state);
      if (!checked.values) { setStatus(checked.message, 'err'); return; }
      saving = (async () => {
        const wait = SAVE_GAP_MS - (Date.now() - lastSaved);
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        try {
          // 合并前重新读取，不覆盖命令行或其他页面刚写入的选项。
          const merged = mergeOptions(await magpie.options.get(), checked.values);
          const request = checkRequest;
          if (request) merged.browserCheck = request;
          const saved = await magpie.options.set(merged);
          if (request && checkRequest === request) { checkRequest = null; void awaitCheck(request); }
          lastSaved = Date.now();
          banner.hidden = true;
          if (!timer) { state = formState(saved); paint(); }
          setStatus('已保存', 'ok');
        } catch (error) {
          setStatus(`保存失败：${error.message ?? error}`, 'err');
        }
      })();
      try { await saving; } finally { saving = null; }
    }
    // 重新载入 models.js（加时间参数避开缓存），返回其中的清单。
    function loadCatalog() {
      return new Promise(resolve => {
        const script = document.createElement('script');
        script.src = `models.js?t=${Date.now()}`;
        script.onload = script.onerror = () => { script.remove(); resolve(globalThis.MAGPIE_CU_CATALOG); };
        document.head.append(script);
      });
    }
    async function awaitCheck(since) {
      const deadline = Date.now() + CHECK_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, CHECK_POLL_MS));
        const fresh = await loadCatalog();
        if (fresh?.browser && Date.parse(fresh.generatedAt) >= since - 1000) {
          browser = fresh.browser;
          checkedAt = fresh.generatedAt;
          checking = null;
          paint();
          return;
        }
      }
      checking = 'timeout';
      paint();
    }
    function startCheck() {
      if (!ready || typeof checking === 'number') return;
      checking = checkRequest = Date.now();
      paint();
      scheduleSave();
    }

    function change(patch) {
      state = { ...state, ...patch };
      paint();
      scheduleSave();
    }

    /* ---- 数字步进 ---- */

    for (const stepper of steppers) {
      const key = stepper.dataset.field;
      const [min, max] = [Number(stepper.dataset.min), Number(stepper.dataset.max)];
      const box = stepper.querySelector('input');
      const commit = value => {
        if (!Number.isInteger(value) || value < min || value > max) {
          stepper.setAttribute('aria-invalid', 'true');
          setStatus(validate({ ...state, [key]: value }).message ?? `应为 ${min}–${max} 的整数`, 'err');
          return;
        }
        stepper.removeAttribute('aria-invalid');
        if (value !== state[key]) change({ [key]: value });
      };
      for (const button of stepper.querySelectorAll('.step')) {
        button.addEventListener('click', () => {
          if (!ready) return;
          const next = Math.min(max, Math.max(min, (Number(box.value) || state[key]) + Number(button.dataset.delta)));
          box.value = String(next);
          commit(next);
        });
      }
      box.addEventListener('change', () => commit(Number(box.value)));
      box.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); box.blur(); } });
    }

    chromeSwitch.addEventListener('click', () => { if (ready) change({ chrome: !state.chrome }); });
    chromeCheck.addEventListener('click', startCheck);

    /* ---- 单选：工具暴露、推理强度、应用授权（竖排用上下键，分段控件用左右键） ---- */

    for (const choice of choices) {
      const field = fieldOf(choice);
      const group = choices.filter(item => fieldOf(item) === field);
      choice.addEventListener('click', () => { if (ready && choice.dataset.value !== state[field]) change({ [field]: choice.dataset.value }); });
      choice.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
        event.preventDefault();
        const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
        const next = group[(group.indexOf(choice) + (forward ? 1 : group.length - 1)) % group.length];
        next.focus();
        next.click();
      });
    }

    /* ---- 模型选择器 ---- */

    let railProvider = null;
    let selected = -1;
    let rows = [];

    function renderRail() {
      rail.replaceChildren();
      const add = (key, label, icon) => {
        const button = html('button', `rail-item${railProvider === key ? ' on' : ''}`);
        button.type = 'button';
        button.dataset.label = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', String(railProvider === key));
        button.append(icon);
        button.addEventListener('click', () => { railProvider = key; renderRail(); renderList(); input.focus(); });
        button.addEventListener('mouseenter', () => showTip(button));
        button.addEventListener('mouseleave', hideTip);
        rail.append(button);
      };
      add(null, '全部', fromSvg(SVG.all));
      if (providers.size) rail.append(html('div', 'rail-sep'));
      for (const item of providers.values()) add(item.id, item.label, iconOf(item.id));
    }

    function showTip(button) {
      const box = button.getBoundingClientRect();
      tip.textContent = button.dataset.label;
      tip.style.left = `${box.right + 8}px`;
      tip.style.top = `${box.top + box.height / 2}px`;
      tip.classList.add('on');
    }
    function hideTip() { tip.classList.remove('on'); }

    function renderList() {
      rows = pickerRows(catalog, { query: input.value, provider: railProvider });
      list.replaceChildren();
      const choosable = [];
      for (const row of rows) {
        if (row.type === 'group') {
          // 只看一个提供方时不再重复它的分组标题
          if (!railProvider) list.append(html('li', 'group', row.label));
          continue;
        }
        const item = html('li');
        item.setAttribute('role', 'option');
        const words = html('span', 'option-words');
        if (row.type === 'reset') {
          item.className = `reset${state.model ? '' : ' cur'}`;
          item.append(fromSvg(SVG.unset));
          words.append(html('span', 'v', '未设置'), html('span', 'n', '由 Agent 调用时指定 model'));
        } else if (row.type === 'custom') {
          item.className = 'custom';
          item.append(fromSvg(SVG.custom));
          words.append(html('span', 'v', `使用 “${row.id}”`), html('span', 'n', '手动输入的模型 ID'));
        } else {
          const { model } = row;
          item.className = model.id === state.model ? 'cur' : '';
          item.title = model.id;
          item.append(iconOf(model.provider));
          words.append(html('span', 'v', model.name));
          const ctx = contextBadge(model.context);
          if (ctx) words.append(html('span', 'badge ctx', ctx));
          if (model.free) words.append(html('span', 'badge free', '免费'));
          words.append(html('span', 'n', row.providerLabel));
        }
        item.append(words, fromSvg(SVG.check));
        const value = row.type === 'reset' ? null : row.type === 'custom' ? row.id : row.model.id;
        item.setAttribute('aria-selected', String(value === state.model));
        item.addEventListener('mousemove', () => select(choosable.indexOf(item)));
        item.addEventListener('click', () => choose(value));
        choosable.push(item);
        list.append(item);
      }
      if (!choosable.length) {
        const none = html('li', 'none');
        none.innerHTML = input.value.trim()
          ? '没有匹配的模型。输入完整的 <b>provider/model</b> 可直接使用。'
          : '这个提供方没有可执行 computer_use 的模型。';
        list.append(none);
      }
      list.choosable = choosable;
      const current = choosable.findIndex(item => item.classList.contains('cur'));
      select(input.value.trim() ? 0 : Math.max(current, 0), true);
    }

    function select(index, scroll = false) {
      const items = list.choosable ?? [];
      if (!items.length) { selected = -1; return; }
      selected = Math.max(0, Math.min(items.length - 1, index));
      items.forEach((item, at) => item.classList.toggle('sel', at === selected));
      if (scroll) items[selected].scrollIntoView({ block: 'nearest' });
    }

    function place() {
      const box = field.getBoundingClientRect();
      const width = Math.min(440, window.innerWidth - 24);
      picker.style.width = `${width}px`;
      const left = Math.max(12, Math.min(box.right - width, window.innerWidth - width - 12));
      picker.style.left = `${left}px`;
      picker.style.setProperty('--ox', `${box.left + box.width / 2 - left}px`);
      const below = window.innerHeight - box.bottom - 12;
      const up = below < 280 && box.top > below;
      picker.classList.toggle('up', up);
      const height = Math.min(420, (up ? box.top : below) - 6);
      picker.style.maxHeight = `${Math.max(180, height)}px`;
      picker.style.top = up ? '' : `${box.bottom + 6}px`;
      picker.style.bottom = up ? `${window.innerHeight - box.top + 6}px` : '';
    }

    function open() {
      if (!ready || !picker.hidden) return;
      input.value = '';
      railProvider = null;
      picker.classList.remove('keying');
      picker.hidden = false;
      field.classList.add('open');
      field.setAttribute('aria-expanded', 'true');
      renderRail();
      renderList();
      place();
      input.focus();
    }

    function close({ focus = true } = {}) {
      if (picker.hidden) return;
      picker.hidden = true;
      hideTip();
      field.classList.remove('open');
      field.setAttribute('aria-expanded', 'false');
      if (focus) field.focus();
    }

    function choose(value) {
      close();
      if (value !== state.model) change({ model: value });
    }

    field.addEventListener('click', () => (picker.hidden ? open() : close()));
    input.addEventListener('input', () => { picker.classList.toggle('keying', Boolean(input.value)); renderList(); });
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); select(selected + 1, true); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); select(selected - 1, true); }
      else if (event.key === 'Enter') { event.preventDefault(); list.choosable?.[selected]?.click(); }
      else if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    document.addEventListener('mousedown', event => {
      if (!picker.hidden && !picker.contains(event.target) && !field.contains(event.target)) close({ focus: false });
    });
    window.addEventListener('resize', () => { if (!picker.hidden) place(); });
    window.addEventListener('blur', () => close({ focus: false }));

    /* ---- 读取设置 ---- */

    $('catalog-note').textContent = catalogNote(catalog);
    paint();
    try {
      if (!magpie?.ready || !magpie.options?.get || !magpie.options?.set) throw new Error('请从 magpie 侧边栏打开本页面。');
      await magpie.ready;
      state = formState(await magpie.options.get());
    } catch (error) {
      banner.textContent = `无法读取设置：${error.message ?? error}`;
      banner.hidden = false;
      setStatus('设置未读取，不能修改', 'err');
      return;
    }
    ready = true;
    for (const control of [field, chromeSwitch, ...choices, ...document.querySelectorAll('.stepper input')]) control.disabled = false;
    paint();
    setStatus('修改会自动保存');
  }

  const api = Object.freeze({ contextBadge, pickerRows, formState, validate, mergeOptions, catalogNote, browserChecks, mount });
  globalThis.MagpieComputerUseSettings = api;
  if (typeof document !== 'undefined' && globalThis.magpie) {
    mount({ document, magpie: globalThis.magpie, catalog: globalThis.MAGPIE_CU_CATALOG });
  }
})();
