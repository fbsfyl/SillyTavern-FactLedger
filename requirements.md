# 环境与依赖要求

本扩展是 **SillyTavern 前端扩展**，没有 Python 依赖，也没有需要 `npm install` 的第三方运行时依赖。下面列出运行、测试和模型侧的要求。

## 1. 运行环境

| 项目 | 要求 | 说明 |
|---|---|---|
| SillyTavern | **1.19.0**（已验证） | 依赖 `getContext()`、`setExtensionPrompt()`、`chatMetadata`、`ConnectionManagerRequestService` 等核心 API |
| SillyTavern 最低版本 | 建议 **1.18+** | 低于 1.18 的版本可能缺少部分上下文 API；未实测 |
| 浏览器 | 现代 Chromium / Firefox / Edge | 需要 ES Module、`structuredClone`、`fetch`、`Blob` |
| 操作系统 | Windows / Linux / macOS | 扩展本身与操作系统无关 |
| 网络 | 可访问你选择的 OpenAI 兼容 API | 例如 `https://api.featherless.ai/v1` |

## 2. Node.js（仅用于单元测试）

| 项目 | 要求 |
|---|---|
| Node.js | **≥ 18**（开发验证使用 v24.20.0） |
| npm 依赖 | **无** |
| 测试命令 | `node --test test/ledger.test.mjs` |

`package.json` 只声明 `"type": "module"`，用于让 Node 把 `lib/ledger.js` 当作 ES Module 解析；不需要 `npm install`。

## 3. SillyTavern 侧能力

扩展使用以下 ST 核心 API，均在 1.19.0 中可用：

- `getContext()`：聊天、角色、事件、设置、metadata
- `chatMetadata` + `saveMetadataDebounced()`：按聊天保存台账
- `setExtensionPrompt(key, value, position, depth, scan, role)`：注入台账块
- `eventSource` + `eventTypes`：`CHAT_CHANGED`、`MESSAGE_RECEIVED`、`GENERATION_AFTER_COMMANDS`
- `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, options)`：按 profile 做独立提取调用
- `generateQuietPrompt({ quietPrompt, responseLength, removeReasoning, skipWIAN })`：跟随当前连接做提取

不需要修改 SillyTavern 源码，不需要服务端插件，不需要重启 Node 服务（刷新前端页面即可）。

## 4. 模型侧要求（提取用）

| 项目 | 建议 |
|---|---|
| 输出格式 | 能稳定输出纯 JSON（不夹解说、不加 Markdown 代码围栏） |
| 上下文 | ≥ 32K（提取提示会带上最近 20 条消息 + 当前台账） |
| 最大输出 | 非思考模型 ≥ 2048；思考模型 ≥ 4096，建议 8192 |
| 中文 | 能理解中文小说文本与角色关系 |
| 温度 | 建议 0.1–0.3（越低越稳定） |
| API | OpenAI 兼容的 `/v1/chat/completions` |

> 主 RP 模型可以继续用你喜欢的写作模型；提取模型可以单独指定。若主模型在 Featherless 上频繁 `capacity_exhausted`，建议给提取单独配一个稳定的小模型，或勾选「跟随当前连接」。

## 5. 存储与权限

| 项目 | 说明 |
|---|---|
| 台账存储 | 当前聊天的 `chatMetadata.factLedger` |
| 导出 | 浏览器下载 JSON 文件 |
| 导入 | 浏览器文件选择器读取 JSON |
| API Key | 由 SillyTavern 的 `secrets.json` 管理；扩展不读取、不写入 |
| 网络权限 | 仅访问你在 SillyTavern 中配置的 API 端点 |
| 文件权限 | 扩展本身不直接读写 SillyTavern 数据目录，除浏览器下载/上传外无文件操作 |

## 6. 不需要的东西

- ❌ Python / `requirements.txt`
- ❌ `npm install`
- ❌ 本地大模型 / GPU
- ❌ Qdrant / ChromaDB / 向量数据库
- ❌ 修改 SillyTavern 核心源码
- ❌ 额外的反向代理（除非你的 API 本身需要）

## 7. 已验证组合

| 项目 | 版本/配置 |
|---|---|
| SillyTavern | 1.19.0（release 06bde93） |
| Node.js | v24.20.0 |
| 浏览器 | Chromium（IDE 内置浏览器） |
| 主 API | Featherless.ai，OpenAI 兼容 |
| 主模型 | `aifeifei798/Qwen3.8-Queen-27B`（测试时） |
| 单元测试 | 130/130 通过 |
| UI/注入/结算 | 浏览器 DOM + JS 求值验证通过 |
