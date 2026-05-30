# Roleplay Hub

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Vue](https://img.shields.io/badge/Vue-3-4FC08D.svg?logo=vue.js)](https://vuejs.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

> **一款纯前端运行的本地角色扮演（Roleplay）对话工具，集成跨设备数据同步。**

**【免责与授权声明】**  
本项目基于 **[CC BY-NC 4.0（知识共享-署名-非商业性使用 4.0 国际许可协议）](./LICENSE)** 开源。**明确禁止任何形式的商业化使用（包括但不限于：作为收费服务提供、打包在付费产品中售卖、在产品内植入广告盈利等）。** 任何使用者必须遵守该协议，尊重原作者的署名权。对于违反协议的商业行为，保留追究法律责任的权利。

---

## 核心特性 (Features)

- **云端跨设备同步**：基于 Cloudflare Workers + R2 的智能分片同步，5MiB 固定分片 + SHA-256 校验，支持增量上传（只传变动分片），单次快照上限 512MiB。
- **流式对话 (Streaming)**：支持 SSE 流式输出，实时渲染 Markdown，CoT（思维链）自动提取与展示。
- **多模型分档**：质量 / 均衡 / 快速 / 建议四档模型配置，按需切换。
- **角色管理**：完整的角色卡管理（导入/导出 JSON，兼容 SillyTavern 格式），支持搜索、分页加载、批量删除。
- **AI 预设 (Presets)**：管理 AI 回复参数（temperature、系统提示词等），支持导入导出、拖拽排序。
- **正则脚本 (Regex Scripts)**：全局 + 角色级两层作用域，支持查找替换、Markdown 渲染前后处理、Prompt 处理，兼容 SillyTavern 格式。
- **世界书 (World Info)**：键值对上下文注入，支持概率触发、递归扫描，全局 + 角色级作用域。
- **UI 模板 (UI Templates)**：动态 HTML/CSS 卡片渲染，支持变量状态管理与 AI 自动更新。
- **活动工具 (Active Tools)**：联网搜索、世界书管理，工具调用队列支持排队、并行与 handoff。
- **记忆系统 (Memory System)**：向量记忆分片 + 语义搜索，支持记忆提取、导入导出。
- **用户多身份**：用户人设多配置管理，一键切换。
- **API 兼容**：OpenAI-compatible 协议，内置 STA1N / OpenAI / DeepSeek / OpenRouter / SiliconFlow 等预设，也支持自定义端点。
- **移动端适配**：响应式布局，键盘 VisualViewport 适配，沉浸模式。

---

## 架构概览 (Architecture)

```
flowchart TB
    subgraph Browser["浏览器 (Vue 3 SPA)"]
        direction TB
        UI["Chat / 角色 / 预设 / 正则 / 世界书 / UI模板 / 工具 / 记忆 / 设置"]
        DB["IndexedDB (RPHubDB)"]
        LS["localStorage"]
    end

    subgraph CF["Cloudflare"]
        W["Workers (src/index.js)"]
        R2["R2 Bucket (rp0527)"]
        A["Static Assets"]
    end

    AI["OpenAI-compatible API\n(STA1N / OpenAI / DeepSeek / OpenRouter / SiliconFlow / 自定义)"]

    UI -->|读写数据| DB
    UI -->|同步密码/公告| LS
    UI -->|"流式对话 (SSE)"| AI
    UI -->|"/api/rp-sync\n推送/拉取快照"| W
    W -->|分片读写| R2
    W -.->|静态资源注入| A
    A -.->|HTMLRewriter| UI

    style Browser fill:#1e3a5f,stroke:#3b82f6,color:#e2e8f0
    style CF fill:#7c3aed,stroke:#a78bfa,color:#e2e8f0
    style AI fill:#166534,stroke:#22c55e,color:#e2e8f0
```

---

## 快速开始 (Quick Start)

本项目无需 Node.js 环境或依赖安装，即开即用。

### 本地运行

1. 下载项目 ZIP 或 `git clone`。
2. 解压到任意文件夹。
3. 双击 `index.html`，在浏览器（推荐 Chrome / Edge / Firefox）中打开即可。

> 若遇到跨域或本地文件读取权限问题，可使用 VS Code 的 `Live Server` 插件，或任意本地静态服务器运行该目录。

### 初始化设置

1. 打开应用后，进入**设置 (Settings)** 页面。
2. 选择一个内置 API 提供商（STA1N / OpenAI / DeepSeek / OpenRouter / SiliconFlow）或切换到**自定义配置**，填入 `API URL` 和 `API Key`。
3. 系统支持自动拉取模型列表，也可手动输入模型名称。按需配置**质量 / 均衡 / 快速 / 建议**四档模型。
4. 在**角色管理**界面导入角色卡（JSON 格式，兼容 SillyTavern），或新建角色并手动填写设定。
5. 回到对话界面，开始 Roleplay！

---

## 云端部署 (Deploy to Cloudflare)

若需要使用跨设备数据同步功能，需将项目部署到 Cloudflare Workers。

### 前置条件

- [Cloudflare 账号](https://dash.cloudflare.com/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npx wrangler --version`)
- 一个 R2 Bucket（绑定名 `RP_SYNC_R2`）

### 部署步骤

```bash
# 1. 登录 Cloudflare
npx wrangler login

# 2. 创建 R2 Bucket（如果还没有）
npx wrangler r2 bucket create rpr2
# 在 `wrangler.toml` 中修改R2绑定名称为你所创建的R2

# 3. (可选) 设置同步密码，在 Cloudflare Dashboard -> Workers & Pages -> 你的 Worker -> Settings -> Variables 中添加：
#    文本变量: RP_SYNC_PASSWORD = 你的密码

# 4. 部署
npx wrangler deploy
```

### 部署文件说明

| 文件 | 说明 |
|------|------|
| `wrangler.toml` | Worker 配置（入口、R2 绑定、静态资源） |
| `src/index.js` | Worker 入口（处理 `/api/rp-sync` 与静态资源） |
| `_worker.js` | Cloudflare Pages Advanced Mode 入口（内容同 `src/index.js`） |
| `DB/bootstrap.js` | 前端同步逻辑（按钮、密码、上传下载） |
| `DB/styles.css` | 同步弹窗样式 |

### R2 同步机制

```
flowchart LR
    subgraph 上传
        A1["浏览器快照"] --> A2["切成 5MiB 分片\n(SHA-256 校验)"]
        A2 --> A3["发送 checksum 清单"]
        A3 --> A4{"Worker 比对\n只要求变动分片"}
        A4 --> A5["上传变动分片"]
        A5 --> A6["Worker multipart\n合成新快照"]
    end
    subgraph 下载
        B1["Worker 读取 manifest"] --> B2["R2 range 分段读取"]
        B2 --> B3["返回原始二进制"]
        B3 --> B4["浏览器合并分片\n恢复完整快照"]
    end

    style 上传 fill:#1e3a5f,stroke:#3b82f6,color:#e2e8f0
    style 下载 fill:#1e3a5f,stroke:#3b82f6,color:#e2e8f0
```

- **增量传输**：只传输变动的分片，未变分片由 Worker 从旧快照按 range 复制。
- **密码保护**：通过环境变量 `RP_SYNC_PASSWORD` 配置，SHA-256 timing-safe 比对。
- **手动触发**：同步为手动模式，不会自动上传覆盖数据。

---

## 目录结构 (Directory Structure)

```text
Roleplay-Hub/
├── index.html              # 主程序入口 (Vue 3 SPA)
├── README.md               # 本说明文件
├── LICENSE                 # CC BY-NC 4.0 许可证
├── _worker.js              # Cloudflare Pages Advanced Mode 入口
├── work.js                 # R2 Worker 源码（同 src/index.js）
├── wrangler.toml           # Cloudflare Workers 部署配置
├── .assetsignore           # 静态资源忽略文件
├── update-upstream.bat     # 更新上游脚本
│
├── assets/
│   ├── css/
│   │   └── styles.css      # 核心样式文件
│   └── js/
│       ├── app.js          # 核心业务逻辑 (Vue 3 Composition API)
│       └── utils.js        # 工具函数 (UUID、时间格式化、CoT 解析)
│
├── DB/
│   ├── README.md           # 同步子系统说明
│   ├── bootstrap.js        # 前端同步逻辑 (按钮、密码、上传下载)
│   ├── styles.css          # 同步弹窗样式
│   └── schema.sql          # 说明文档 (R2 版不使用 D1)
│
├── src/
│   └── index.js            # Cloudflare Workers 服务端入口
│
└── character/
    └── index.html           # 辅助页面
```

---

## 技术栈 (Tech Stack)

| 层次 | 技术 | 说明 |
|------|------|------|
| 前端框架 | Vue 3 (CDN) | Composition API，无构建工具 |
| UI 样式 | Tailwind CSS (CDN) | 响应式设计，自定义主题色 |
| Markdown | marked (CDN) | 对话内容渲染 |
| XSS 防护 | DOMPurify (CDN) | 消息内容安全净化 |
| 拖拽排序 | SortableJS (CDN) | 预设、正则、世界书排序 |
| 本地存储 | IndexedDB + localStorage | `RPHubDB` 为主存储，兼容 SillyTavernDB 迁移 |
| 服务端 | Cloudflare Workers | 处理同步 API 与静态资源 |
| 对象存储 | Cloudflare R2 | 快照存储，分片上传下载 |
| API 协议 | OpenAI-compatible | 支持多家提供商 |

---

## SillyTavern 兼容性

项目支持导入/导出与 SillyTavern 兼容的角色卡格式（JSON）：

- 角色卡导入/导出（自动转换字段名）
- 正则脚本兼容（`disabled` 字段自动转换 `true` <-> `false`）
- 旧版数据迁移（自动从 `SillyTavernDB` 导入到 `RPHubDB`）

---

## 协议与许可 (License)

本项目严格遵守以下开源协议：

**[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans)**

* **您可以**：自由地共享（在任何媒介以任何形式复制、发行本作品）与演绎（修改、转换或以本作品为基础进行创作）。
* **您必须**：
  * **署名 (Attribution)**：给出适当的署名，提供指向本许可协议的链接，同时标明是否对原始作品作了修改。
  * **非商业性使用 (NonCommercial)**：**您不得将本作品或演绎作品用于任何商业目的。** 禁止任何形式的售卖、付费订阅集成或利用本项目进行广告牟利。
* 若要获取本项目的商业授权，请直接联系项目原作者。

详细许可条款请参见根目录下的 [`LICENSE`](./LICENSE) 文件。
