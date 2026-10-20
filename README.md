# AgentFlow · DSH 插件

> 在 DeepSeek Harness 里用**画布**编排 agent 工作流，一键生成 DSH 预设 —— 每一步由你定义，而不是塞进一个黑盒循环。

[![npm](https://img.shields.io/npm/v/dsh-plugin-agentflow?color=24543F&label=npm)](https://www.npmjs.com/package/dsh-plugin-agentflow)
[![license](https://img.shields.io/badge/license-MIT-24543F)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-6aa583)](https://github.com/deepseek-ai)

![画布](docs/images/canvas-light.png)

## 是什么

DSH 自带的 agent 是「一个模型 + 一堆工具」的循环，中间怎么想、调什么，你看不见也改不了。

AgentFlow 把它掰开：**画布上的每张卡片就是一个 agent 步骤**。你决定有几步、谁先谁后、谁并行、每步用哪个模型、能不能调 MCP 工具、做完怎么验收。编排好之后导出成一个 DSH 预设，在对话里直接选中它。

- **节点**：LLM（调模型）/ MCP（直接调工具，不经过模型）/ 调度（根，对话入口）
- **执行**：纯 DAG，无上游先跑、同层并行、失败不阻塞其它分支
- **模型**：全部走 DSH 自己的模型通道（`ctx.llm`），推理强度和兜底模型可逐节点配
- **预设**：根节点承载人格，导出时自动附上子节点清单，写进 DSH profile

## 安装

### 从 npm

DSH → 设置 → 插件 → 添加插件 → 输入：

```
dsh-plugin-agentflow
```

### 从 GitHub

```
CC19990113/dsh-plugin-agentflow
```

装完重启 DSH。左侧栏出现 **AgentFlow** 入口，后端由插件自动拉起（默认 `127.0.0.1:8791`），不需要手动跑命令。

要求：DSH 桌面版 0.2.x、Node 22+。

## 怎么用

### 1. 画布列表

![画布列表](docs/images/boards-list.png)

每张画布对应一个 DSH 预设。卡片上会标出「对话入口」（哪张卡是和用户对话的根节点），改过画布但没更新预设时显示 **预设未更新**。

### 2. 编排

- 拖卡片改位置，从卡片边缘拖线连上下游
- 点卡片改模型、推理强度、兜底模型、技能、MCP 工具
- 「加下游 / 加上游」快速派生新卡
- 编辑**自动保存**，点「保存」才会把你的编排**生成/覆盖成 DSH 预设**

### 3. 验证

顶栏「验证 AgentFlow」会真实跑一遍整张图（会消耗 token），用来看流程通不通。卡片上只显示配置摘要，不堆运行产出。

### 4. 导出成预设

点「保存」（或 ⌘S）→ 画布落库 + 预设写入 `~/.dsh/profiles/<profile>/cordis.patch.yml`。重启 DSH 后，新会话的预设列表里就能选到它。

预设长这样：

```
你是「AgentFlow」的对话入口。
你只负责和用户对话：问清需求、确认关键信息。
需求明确后，严格按照后续节点的 AgentFlow 流去执行，不要自己直接产出结果。

【完成标准】…
【子节点】共 4 个
- 大纲：根据给定的题材，写一个三幕剧的简要大纲
- 对白版：为关键场景写几句有张力的对白
…
```

## 深色模式

![深色](docs/images/canvas-dark.png)

主题跟随 DSH：插件把当前主题拼进 iframe 地址，画布启动时按它初始化；手动切换只在本次会话内生效，DSH 重开时重新读配置。

## 架构

```
DSH 桌面
├── 插件（index.js）
│   ├── 工具：agentflow_list / agentflow_run
│   ├── 客户端：侧边栏入口、设置页分区、画布 iframe
│   └── 子进程：node runtime/server.mjs → 127.0.0.1:8791
│       ├── engine.mjs   纯 DAG 执行器
│       ├── llm.mjs      调模型（只走 bridge）
│       └── web/dist     画布前端
└── llm bridge（lib/bridge.js）
    └── 把 ctx.llm 暴露给引擎，模型调用始终在 DSH 进程内
```

`runtime/` 是打包时从引擎仓库同步过来的副本（`npm run sync`），所以插件自带完整引擎，装完即用。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| 数据目录 | `~/.dsh/agent-flow-data` | 首次启动会自动从 `~/.dsh/agent-flow/data` 迁移 |
| 后端端口 | `8791` | 可用 `agentflowPort` 插件配置改 |
| 预设 profile | `desktop` | 用环境变量 `AGENTFLOW_PROFILE` 指定别的 profile |

## 限制

- **只在 macOS 上验证过**，Windows 的路径与命令未测
- 运行态是全局的：跑图时切换画布，事件会被丢弃；「停止」不分画布
- 验证跑图会真实调用模型，注意 token 消耗
- 预设依赖 DSH profile 的 patch 机制，profile 结构变了要跟着调整

## 开发

```bash
npm run build   # 构建客户端 bundle（lib/client.js）
npm run sync    # 从 ~/.dsh/agent-flow 同步引擎到 runtime/
npm run check   # 语法检查
npm test        # 插件自测（83 项）
```

引擎侧测试在 `~/.dsh/agent-flow/test`（85 项）。

## License

[MIT](./LICENSE)
