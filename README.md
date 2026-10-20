# dsh-plugin-agentflow

把 AgentFlow（物料画布式 agent 编排器）接进 DeepSeek Harness 的桌面插件：

- 设置页 / 侧边栏嵌入画布界面（本地后端 `http://127.0.0.1:8791`）
- 模型工具 `agentflow_list` / `agentflow_run`：看画布、跑画布
- 引擎随插件分发（`runtime/`），装完即用，不需要单独安装 `~/.dsh/agent-flow`
- 模型调用走 DSH 内核的 llm bridge（插件在 DSH 进程里起），不再自带 provider 凭据

## 安装

DSH 桌面版 → **设置 → 插件 → 添加插件**，然后二选一：

- 输入 GitHub 仓库地址（例：`https://github.com/<owner>/dsh-plugin-agentflow`）
- 输入本地目录（克隆下来的插件目录）

DSH 会安装插件依赖并加载；侧边栏/设置页出现 AgentFlow 即成功，**不需要手动起服务、不需要构建前端**（仓库里已包含构建好的客户端与 `runtime/` 引擎）。

## 首次启动会发生什么

1. 插件用当前 DSH 的 Node 进程拉起 `runtime/server.mjs`（先探测 8791 端口，已在跑就不重复起；日志丢弃，不污染 DSH 终端）
2. 后端监听 `127.0.0.1:8791`，数据目录默认 `~/.dsh/agent-flow-data`
3. 若新数据目录不存在或为空，且旧目录 `~/.dsh/agent-flow/data` 里有 `board.json`，会自动把旧数据抄一份过来（只抄一次，旧文件保留不动）
4. 新环境没有画布时，后端会自动建一张默认画布，打开页面即可看到

## 数据目录

默认：`~/.dsh/agent-flow-data/`

```
boards.json            # 画布索引
boards/<id>.json       # 每张画布
config.json            # 引擎配置（含密钥时权限 0600）
drafts/                # 画布草稿
data/dsh-bridge.json   # DSH llm bridge 的发现文件（进程级 token）
```

覆盖方式（优先级从高到低）：

| 方式 | 例子 |
| --- | --- |
| 插件配置 `dataDir` | `{ "dataDir": "/path/to/data" }` |
| 环境变量 `AGENTFLOW_DATA_DIR` | 启动 DSH 前 export |
| 默认值 | `~/.dsh/agent-flow-data` |

数据目录别放进插件安装目录：升级/重装插件会覆盖安装目录。

## 依赖

- DSH 0.2.x（插件依赖 `@deepseek-ai/dsh-tools ^0.2.1-rc.2`、`@deepseek-ai/cordis ^4.0.5`）
- Node 22+（后端用到 `fetch`、`AbortSignal.timeout`、`fs.cp`）
- 模型通道：引擎通过 DSH 内置的 llm bridge 调模型，需要 DSH 正在运行且插件已加载。DSH 没起 / 插件未加载时，画布仍能打开和编辑；关掉 mock 后跑图会失败，错误含「DSH 内核未连接」
- 引擎默认是 mock 模式（返回假输出，不调用模型）；在画布设置里关掉 mock 才会真正调模型

## 预设导出

画布可导出成 DSH 预设，写入 `~/.dsh/profiles/<profile>/`（默认 profile 为 `desktop`）。

- 换 profile：启动 DSH 前设置 `AGENTFLOW_PROFILE=<profile 名>`，后端子进程会继承
- profile 目录不存在时导出接口返回 400，并提示具体路径

## 开发

```bash
npm install
npm run sync     # 把 ~/.dsh/agent-flow 的引擎快照进 runtime/（清空重建）
npm run check    # node --check
npm test         # bridge 自测
npm run build    # 构建客户端 bundle（改了 src/client.tsx 才需要）
```

- `runtime/` 是 `npm run sync` 的生成物，不要手改；引擎更新后重新跑一次 sync
- 开发时想直接改引擎源码，不必每次 sync：配 `agentflowDir` 或设 `AGENTFLOW_DIR=~/.dsh/agent-flow`，插件会改用该目录的引擎（此时 bridge 发现文件也写在该目录的 `data/` 下）
- 同步源可用 `AGENTFLOW_SRC=/path/to/agent-flow npm run sync` 指定

插件配置项：

| 配置 | 说明 |
| --- | --- |
| `agentflowDir` | 引擎目录（开发用），覆盖自带 `runtime/` |
| `agentflowPort` | 后端端口，默认 `8791`（界面目前固定连 8791，改端口需同步改客户端） |
| `dataDir` | 数据目录，默认 `~/.dsh/agent-flow-data` |

## 限制

- 只在 macOS 上验证过；Windows 未测试（路径、进程管理可能还需适配）
- 端口默认固定 `8791`；被别的实例占用时，探测到存活就复用，否则启动会失败（插件客户端的 iframe 也写死了 8791，改端口需要同时改客户端）
- 一个 DSH 进程只托管一个自建后端；插件卸载时会杀掉自己拉起的那个，外部已在跑的不管
- 引擎是插件版本快照：升级引擎需要重新 `npm run sync` 并发布新版本插件
