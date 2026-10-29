/** 命令行入口。`mcp` 由 magpie 资源库启动；其余命令用于诊断与手动登记/移除。 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BIN_PATH, VERSION, defaultMagpieConfigDirectory } from './config.mjs';
import { formatReport, runDoctor } from './doctor.mjs';
import { createGatewayClient, formatModelList } from './gateway.mjs';
import { installClaudeHook, recordHookInput, uninstallClaudeHook } from './claude-hook.mjs';
import { ensureLibraryMcp, isOwnEntry, ownEntry, readLibrary, removeLibraryMcp } from './library.mjs';
import { readPluginOptions } from './options.mjs';
import { serveStdio } from './server.mjs';

const USAGE = `用法：
  magpie-computer-use mcp                              启动 stdio MCP 服务（由 magpie 资源库调用）
  magpie-computer-use doctor [--live] [--json]         检查 LCU、插件选项、magpie 网关、资源库登记与运行时连接
  magpie-computer-use models [--config-dir DIR]        列出可执行 computer_use 的模型与当前默认模型
  magpie-computer-use register [--config-dir DIR]      登记到 magpie 资源库（插件加载时也会自动登记）
  magpie-computer-use unregister [--config-dir DIR]    从 magpie 资源库移除本插件的登记
  magpie-computer-use claude-hook install|uninstall      在 Claude Code 中安装/移除“跟随 Agent 权限”所需的钩子
  magpie-computer-use --version`;

const OPTIONS = {
  live: { type: 'boolean' },
  json: { type: 'boolean' },
  'config-dir': { type: 'string' },
};

function configDirectoryOf(values) {
  return path.resolve(values['config-dir'] ?? defaultMagpieConfigDirectory());
}

// 手动命令沿用资源库中已有的启动程序（由 magpie 提供），找不到时才使用当前 Node。
async function launcherFor(directory) {
  const entry = ownEntry(await readLibrary(directory));
  return entry && isOwnEntry(entry) && entry.args[0] === BIN_PATH ? entry.command : process.execPath;
}

/** 执行一条命令并返回退出码；返回 undefined 表示 MCP 服务仍在运行，由 stdin 关闭结束进程。 */
export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout }) {
  const [command, ...rest] = argv;
  if (command === '--version' || command === '-v') {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command === 'mcp') {
    await serveStdio();
    return undefined;
  }
  if (command === 'claude-hook') {
    const [action] = rest;
    if (action === 'install') { io.stdout.write(await installClaudeHook() ? '已在 Claude Code 设置中安装钩子。\n' : '钩子已安装，无需改动。\n'); return 0; }
    if (action === 'uninstall') { io.stdout.write(await uninstallClaudeHook() ? '已移除钩子。\n' : '没有找到本插件的钩子。\n'); return 0; }
    // 由 Claude Code 调用：从标准输入读取钩子数据并记录权限模式；静默退出，不影响 Claude Code 的判断。
    const input = await new Promise(resolve => {
      let text = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { text += chunk; });
      process.stdin.on('end', () => resolve(text));
      process.stdin.on('error', () => resolve(text));
    });
    await recordHookInput(input).catch(() => {});
    return 0;
  }
  if (command === 'doctor') {
    const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true });
    const report = await runDoctor({ configDirectory: configDirectoryOf(values), live: values.live });
    io.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
    return report.ok ? 0 : 1;
  }
  if (command === 'models') {
    const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true });
    const options = await readPluginOptions({ directory: configDirectoryOf(values) });
    const gateway = createGatewayClient({ url: options.gatewayUrl, key: options.gatewayKey });
    io.stdout.write(`${formatModelList(await gateway.listModels(), { url: gateway.url, defaultModel: options.model })}\n`);
    return 0;
  }
  if (command === 'register') {
    const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true });
    const directory = configDirectoryOf(values);
    const result = await ensureLibraryMcp({ directory }, undefined, { launcher: await launcherFor(directory) });
    io.stdout.write(result.created ? '已登记到 magpie 资源库。\n' : result.refreshed ? '已刷新 magpie 资源库中的登记。\n' : '资源库中已有相同登记。\n');
    return 0;
  }
  if (command === 'unregister') {
    const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true });
    const directory = configDirectoryOf(values);
    // 只移除资源库中实际存在、指向本包入口的条目，因此使用其记录的启动程序与参数作为定义。
    const entry = ownEntry(await readLibrary(directory));
    const removed = entry && isOwnEntry(entry) && entry.args[0] === BIN_PATH
      ? await removeLibraryMcp(directory, { name: entry.name, transport: entry.transport, command: entry.command, args: entry.args })
      : false;
    io.stdout.write(removed ? '已从 magpie 资源库移除。\n' : '资源库中没有指向当前安装的登记，未做改动。\n');
    return 0;
  }
  throw new Error(`未知命令：${command}\n${USAGE}`);
}
