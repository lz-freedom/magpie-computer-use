/**
 * magpie 扩展入口：加载扩展时登记资源库中的 MCP，并启动卸载清理监视。
 * 工具由资源库中的独立 MCP（bin/magpie-computer-use.mjs mcp）提供；这里不启动 LCU，也不读取其配置。
 */
import { refreshCatalog } from './src/catalog.mjs';
import { installClaudeHook } from './src/claude-hook.mjs';
import { normalizeOptions } from './src/options.mjs';
import { startCleanupWatcher } from './src/cleanup.mjs';
import { ensureLibraryMcp } from './src/library.mjs';

function wantsAgentMode(options) {
  try { return normalizeOptions(options ?? {}).approval === 'agent'; } catch { return false; }
}

function createPlugin(dependencies) {
  return {
    id: 'magpie-computer-use',
    async server(input, options) {
      // 插件加载即登记资源库；Agent 选择和分发交给 magpie。
      const { definition } = await ensureLibraryMcp(input, options, dependencies);
      // 监视安装记录而非宿主退出；正常移除扩展后自动撤销本插件的 MCP 分发。
      await startCleanupWatcher(input, definition, dependencies);
      // 为设置页准备模型清单；在后台进行，不拖慢插件加载，失败时页面改为手动输入。
      void refreshCatalog(options, { directory: input.directory });
      // 选择“跟随 Agent”时，在 Claude Code 中安装读取权限模式所需的钩子（只增改本插件自己的条目）。
      if (wantsAgentMode(options)) void installClaudeHook().catch(() => {});
      // 返回空的插件钩子集合：工具由资源库中的独立 MCP 连接提供。
      return {};
    },
  };
}

// 辅助函数放在对象内，避免 magpie 将命名导出误识别为额外插件入口。
export const _internal = Object.freeze({ createPlugin });
export default createPlugin();
