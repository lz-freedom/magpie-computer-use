# 第三方组件

## LCU（运行时依赖，未包含在本项目中）

- 仓库：https://github.com/amontlabs/lcu
- 许可：MIT，Copyright (c) 2026 Amont Labs
- 本项目不复制、不打包 LCU。运行时使用用户本机安装的 LCU：读取其安装目录中的 `bin/lcu`、`adapters/client.mjs` 与 `installation.json`，并调用其官方共享客户端。LCU 的安装与升级由用户完成。

## LobeHub 图标（依赖）

- 包：`@lobehub/icons-static-svg` 1.101.0，MIT，https://github.com/lobehub/lobe-icons
- magpie 的提供方配置中，内置图标以名称引用（例如 `opencode`、`minimax-color`），这些名称与该图标库的文件名一致；设置页据此显示提供方图标。

## Model Context Protocol TypeScript SDK（依赖）

- 包：`@modelcontextprotocol/sdk` 1.30.0，MIT。用于对 Agent 提供 stdio MCP 服务。

## OpenAI 与 ChatGPT

- 本项目不包含、不复制、不修改 OpenAI 的应用、二进制或指令。Computer Use 运行时来自用户已安装的 ChatGPT 桌面应用，并保留其原有条款与权限要求。

## 模型

- `computer_use` 调用的模型由用户在 magpie 中配置的提供方提供，经本机 magpie 网关访问，适用各提供方自己的条款。
