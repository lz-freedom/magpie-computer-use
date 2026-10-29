// 真实环境冒烟测试：通过 stdio 启动本插件的 MCP，连接本机已安装的 LCU（与 magpie 网关）。
//   默认：只读，列出工具并调用 list_apps。
//   --app <名称>：额外对该应用执行 get_app_state（选择应用并截图），不点击。
//   --task "<任务>" [--model provider/model] [--max-steps N]：用 computer_use 把任务交给模型执行，打印进度与报告。
//     任务内容决定会做什么；请只给出你愿意让模型实际执行的任务。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BIN_PATH } from '../src/config.mjs';

const argument = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const app = argument('--app');
const task = argument('--task');
const model = argument('--model');
const maxSteps = argument('--max-steps');

const summarize = result => result.content.map(part => (
  part.type === 'text' ? `text(${part.text.length} chars): ${part.text.slice(0, 160).replace(/\s+/g, ' ')}…` : `${part.type}(${part.mimeType ?? ''})`
)).join('\n  ');

const transport = new StdioClientTransport({ command: process.execPath, args: [BIN_PATH, 'mcp'] });
const client = new Client({ name: 'magpie-computer-use-smoke', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);
try {
  const { tools } = await client.listTools();
  console.log(`tools (${tools.length}): ${tools.map(tool => tool.name).join(', ')}`);
  if (task) {
    const args = { task, ...(model ? { model } : {}), ...(maxSteps ? { max_steps: Number(maxSteps) } : {}) };
    const started = Date.now();
    const result = await client.callTool({ name: 'computer_use', arguments: args }, undefined, {
      timeout: 600_000, resetTimeoutOnProgress: true,
      onprogress: update => console.log(`  [${update.progress}/${update.total}] ${update.message}`),
    });
    console.log(`computer_use isError=${Boolean(result.isError)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    for (const part of result.content) console.log(part.type === 'text' ? part.text : `[${part.type}]`);
  } else {
    const listed = await client.callTool({ name: 'list_apps', arguments: {} });
    console.log(`list_apps isError=${Boolean(listed.isError)}\n  ${summarize(listed)}`);
    if (app) {
      const state = await client.callTool({ name: 'get_app_state', arguments: { app } });
      console.log(`get_app_state(${app}) isError=${Boolean(state.isError)}\n  ${summarize(state)}`);
    }
  }
} finally {
  await client.close();
}
