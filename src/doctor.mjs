/**
 * magpie-computer-use doctor：默认只读检查安装状态、插件选项、magpie 网关与 LCU 布局；--live 额外连接 LCU，
 * 只列出公开工具并读取初始化说明，不访问任何应用，因此不会触发 Computer Use 授权，也不调用模型。
 */
import { execFile } from 'node:child_process';
import { BIN_PATH, MIN_LCU_VERSION, PLUGIN_NAME, TESTED_LCU_VERSION, VERSION, defaultMagpieConfigDirectory } from './config.mjs';
import { browserStatus, compareVersions, discoverLcu, LcuNotFoundError } from './lcu.mjs';
import { isOwnEntry, ownEntry, readLibrary } from './library.mjs';
import { createGatewayClient, supportsComputerUse } from './gateway.mjs';
import { readPluginOptions } from './options.mjs';
import { findPluginEntry } from './plugin-entry.mjs';
import { openLcuRuntime } from './server.mjs';

const ICON = { ok: '✔', warn: '!', error: '✘' };

function execJson(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
  });
}

/** 执行全部检查，返回 { checks, ok }；checks 每项含 name、status（ok/warn/error）与 detail。 */
export async function runDoctor({
  configDirectory = defaultMagpieConfigDirectory(), live = false,
  discover = discoverLcu, readStatus = execJson, connect = openLcuRuntime,
  loadOptions = () => readPluginOptions({ directory: configDirectory }), createGateway = createGatewayClient,
  findEntry = () => findPluginEntry(configDirectory), readBrowser = browserStatus,
} = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  if (process.platform === 'darwin' && process.arch === 'arm64') add('平台', 'ok', 'macOS Apple Silicon');
  else add('平台', 'error', `${process.platform}-${process.arch}；LCU 只支持 Apple Silicon macOS`);
  add('插件', 'ok', `${PLUGIN_NAME} ${VERSION}（${BIN_PATH}）`);
  add('Node 运行时', 'ok', `${process.execPath}（${process.version}）`);

  try {
    const library = await readLibrary(configDirectory);
    // 启动程序由 magpie 决定（插件加载时使用 magpie 自带的运行时），这里只核对入口路径。
    const entry = ownEntry(library);
    if (!entry) add('magpie 资源库', 'warn', `尚未登记 ${PLUGIN_NAME}；插件加载时会自动登记`);
    else if (isOwnEntry(entry) && entry.args[0] === BIN_PATH) add('magpie 资源库', 'ok', `已登记，指向当前安装（Agent：${(entry.agents ?? []).join(', ') || '未分发'}）`);
    else if (isOwnEntry(entry)) add('magpie 资源库', 'warn', `登记指向其他安装：${entry.args[0]}；下次加载插件时会刷新`);
    else add('magpie 资源库', 'error', `同名的其他 MCP 已存在；插件不会覆盖它，请在资源库中检查或重命名`);
  } catch (error) {
    add('magpie 资源库', 'error', error.message);
  }

  // 插件选项与委托模型：computer_use 通过 magpie 网关调用这里设置的模型。
  let options;
  try {
    const entry = await findEntry();
    options = await loadOptions();
    const where = entry ? '' : '（插件未在 magpie 中安装，使用默认值）';
    add('插件选项', 'ok', `tools=${options.tools}，maxSteps=${options.maxSteps}，网关 ${options.gatewayUrl}${where}`);
  } catch (error) {
    add('插件选项', 'error', `${error.message}。用 magpie plugin options magpie-computer-use 查看与修改。`);
  }
  if (options) {
    try {
      const models = await createGateway({ url: options.gatewayUrl, key: options.gatewayKey }).listModels();
      const usable = models.filter(model => supportsComputerUse(model) !== false);
      add('magpie 网关', 'ok', `${options.gatewayUrl} 可用，${usable.length}/${models.length} 个模型可执行 computer_use`);
      if (!options.model) {
        add('委托模型', options.tools === 'direct' ? 'ok' : 'warn',
          '未设置默认模型；computer_use 需要调用时传入 model，或运行 magpie plugin options magpie-computer-use \'{"model":"provider/model"}\'');
      } else {
        const found = models.find(model => model.id === options.model);
        if (!found) add('委托模型', 'error', `${options.model} 不在网关的模型列表中；运行 magpie-computer-use models 查看可用模型`);
        else if (supportsComputerUse(found) === false) add('委托模型', 'error', `${options.model} 不能接收截图或不支持工具调用`);
        else add('委托模型', 'ok', `${options.model}（${found.magpie_label ?? found.display_name ?? '已找到'}）`);
      }
    } catch (error) {
      add('magpie 网关', options.tools === 'direct' ? 'warn' : 'error', error.message);
    }
  }

  let info;
  try {
    info = await discover();
    const versionNote = compareVersions(info.version, MIN_LCU_VERSION) < 0
      ? { status: 'error', text: `低于要求的 ${MIN_LCU_VERSION}，请运行 lcu update` }
      : info.version === TESTED_LCU_VERSION
        ? { status: 'ok', text: '已在本插件联调过的版本' }
        : { status: 'warn', text: `未在该版本联调（已验证 ${TESTED_LCU_VERSION}），仍会尝试使用` };
    add('LCU', versionNote.status, `${info.version}，位于 ${info.root}（来源：${info.source}）。${versionNote.text}`);
    add('ChatGPT 应用', 'ok', `${info.app ?? '未知路径'}，运行时 ${info.runtime ?? '未知'}`);
  } catch (error) {
    add('LCU', 'error', error instanceof LcuNotFoundError ? error.message : `LCU 发现失败：${error.message}`);
  }

  if (info) {
    try {
      const status = await readStatus(info.launcher, ['status', '--json'], 90_000);
      const compatibility = status.compatibility ?? {};
      if (compatibility.warning) add('LCU 兼容性', 'warn', compatibility.warning);
      else add('LCU 兼容性', 'ok', `${compatibility.status ?? '未知'}：ChatGPT ${status.app?.version ?? '?'}，CUA ${status.app?.runtime ?? '?'}`);
    } catch (error) {
      add('LCU 兼容性', 'warn', `无法读取 lcu status：${error.message.split('\n')[0]}`);
    }
    // 浏览器开关打开时检查 Chrome 连接器与扩展（扩展状态可能因 macOS 保护 Chrome 配置而读不到）。
    if (options?.chrome) {
      try {
        const browser = await readBrowser(info.launcher);
        if (browser.connector === 'lcu') add('Chrome 连接器', 'ok', '已指向本 LCU');
        else add('Chrome 连接器', 'warn', '还没指向本 LCU；下一次调用会自动运行 lcu browser install，也可以手动运行');
        if (browser.extension === 'enabled') add('Chrome 扩展', 'ok', 'ChatGPT 扩展已启用');
        else if (browser.extension === 'missing') add('Chrome 扩展', 'warn', '没有安装或没有启用 ChatGPT 扩展：https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg');
        else add('Chrome 扩展', 'warn', '无法读取 Chrome 配置（macOS 保护），请自行确认 ChatGPT 扩展已安装并启用');
      } catch (error) {
        add('Chrome 连接器', 'warn', `无法读取 lcu browser status：${error.message.split('\n')[0]}`);
      }
    }
  }

  if (live) {
    if (!info) add('运行时连接', 'error', '未找到 LCU，跳过连接检查');
    else {
      let runtime;
      try {
        runtime = await connect();
        const names = runtime.client.publicTools().map(tool => tool.name).sort();
        const instructions = runtime.client.instructions;
        add('运行时连接', 'ok', `已连接 LCU ${runtime.info.version}；公开工具：${names.join(', ')}；初始化说明 ${instructions.length} 字符`);
      } catch (error) {
        add('运行时连接', 'error', error.message.split('\n').slice(0, 4).join('\n'));
      } finally {
        await runtime?.client.close().catch(() => {});
      }
    }
  }

  return { checks, ok: checks.every(check => check.status !== 'error') };
}

export function formatReport({ checks, ok }) {
  const lines = checks.map(check => `${ICON[check.status]} ${check.name}：${check.detail}`);
  lines.push('', ok ? '检查通过（警告项仅供参考）。' : '存在错误，请按上面的提示修复后重试。');
  return lines.join('\n');
}
