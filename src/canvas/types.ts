// 数据模型 —— 前后端共用的契约。改这里要同步 server.mjs。

export type NodeStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'review';

export type VerifyMode = '' | 'human' | 'jev' | 'self';

export interface Verdict {
  by: 'human' | 'jev' | 'self' | string;
  pass: boolean;
  reason: string;
  at: number;
}

export interface Usage {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  ms?: number;
}

export interface FlowNode {
  id: string;
  label: string;
  type: string;
  x: number;
  y: number;
  /** 具体模型 id（deepseek-flash / deepseek-v4-pro）；老画布里这里是 provider 名 */
  model: string;
  /** provider 路由 id（deepseek-account / deepseek-official）；空 = 老画布，按 model 推断 */
  provider?: string;
  /** 推理强度（low / high / max）；空 = 用模型自己的默认档 */
  reasoningEffort?: string;
  fallback: string[];
  /** 兜底模型各自的推理强度，key 是 `provider/model`；缺省 = 模型默认 */
  fallbackEfforts?: Record<string, string>;
  /** MCP 节点：单个工具（server.tool）与参数模板；type==='mcp' 时有意义 */
  tool?: string;
  args?: Record<string, unknown>;
  task: string;
  criteria: string;
  skills: string[];
  tools: string[];
  verify: VerifyMode;
  content: string;
  /** 流式预览：只在 running 时短暂存在，done 之后让位给 content */
  delta?: string;
  status: NodeStatus;
  usage: Usage | null;
  error: string | null;
  verdict: Verdict | null;
}

export interface Edge {
  from: string;
  to: string;
}

export interface Board {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: Edge[];
}

/** GET /api/boards 列表里的一条（不含节点内容） */
export interface BoardMeta {
  id: string;
  name: string;
  /** 绑定的自定义预设 id；新建的空白画布为 null */
  presetId: string | null;
  nodeCount: number;
  updatedAt: number;
  /** 是否有未保存的草稿（后端列表接口提供；旧服务可能没有这个字段） */
  hasDraft?: boolean;
  /** 画布改过但还没点「保存」：预设还是旧的 */
  presetOutdated?: boolean;
}

/** GET /api/presets 里的一条（列表页只需要这些） */
export interface PresetRow {
  rowId: string;
  id: string;
  name: string;
  description: string;
  /** bundle = DSH 插件自带；profile = 用户自定义 */
  source: 'bundle' | 'profile' | string;
  packageName: string | null;
  order: number;
  editable: boolean;
  canCopy: boolean;
}

export interface Skill {
  name: string;
  description: string;
  path: string;
}

export interface McpTool {
  name: string;
  description: string;
}

export interface McpServer {
  name: string;
  ok: boolean;
  error?: string;
  tools: McpTool[];
}

export interface ProviderInfo {
  label: string;
  baseURL: string;
  model: string;
  hasKey: boolean;
}

export interface ConfigInfo {
  mock: boolean;
  providers: Record<string, ProviderInfo>;
}

/** 目录里的一个具体模型：推理档位由 DSH /models 给出，不是我们编的 */
export interface CatalogModel {
  id: string;
  name: string;
  /** 支持的推理强度，如 ["low","high","max"] */
  levels: string[];
  /** 模型自己的默认档，如 "high" */
  defaultLevel: string;
}

/** 一条 provider 路由（DeepSeek 账号 / DeepSeek API key） */
export interface CatalogProvider {
  id: string;
  label: string;
  models: CatalogModel[];
  /** 这条路由没读通时的原因；有值时 models 为空 */
  error: string | null;
}

export interface ModelCatalog {
  providers: CatalogProvider[];
  fetchedAt: number;
  cached?: boolean;
  /** bridge 读不通时的原因；有值时 providers 为空 */
  error?: string;
}

/** bridge 连接状态：AgentFlow 的模型通道只有 DSH 内核这一条 */
export interface BridgeStatus {
  /** 发现文件是否存在（DSH 插件是否加载过） */
  configured: boolean;
  /** 健康检查是否通过；false 时不可跑图 */
  healthy: boolean;
  /** 不可用原因（可读文案）；可用时为 null */
  reason: string | null;
  /** 目录里读到的 provider 数量 */
  providers: number;
  /** 最近一次成功读到目录距今多久（ms）；从未成功为 null */
  catalogAgeMs: number | null;
  /** bridge 发现文件所在目录（AGENTFLOW_BRIDGE_DIR 或 AgentFlow 根） */
  dir: string;
  /** 发现文件绝对路径 */
  infoPath: string;
  /** 发现文件里的协议版本；未连接时为 null */
  version: number | null;
  /** 插件启动时间戳（ms）；未连接时为 null */
  startedAt: number | null;
  /** 目录里的模型总数（healthy 时为当次读取结果，读失败为 0） */
  modelCount: number;
  /** 最近一次 health / catalog 失败的原因，成功时清空 */
  lastError: string | null;
}

/** SSE 事件 */
export type RunEvent =
  | { type: 'run:start'; targets: string[] | 'all'; mock: boolean }
  | { type: 'node:start'; id: string }
  | { type: 'node:delta'; id: string; chunk: string }
  | {
      type: 'node:done';
      id: string;
      model: string;
      content: string;
      usage: Usage;
      verdict: Verdict | null;
      status: NodeStatus;
      dry?: boolean;
    }
  | { type: 'node:retry'; id: string; model: string; error: string }
  | { type: 'node:failed'; id: string; tried: { model: string; error: string }[] }
  | { type: 'node:blocked'; id: string; reason: string }
  | {
      type: 'run:end';
      summary: {
        done: string[];
        failed: string[];
        blocked: string[];
        review: string[];
      };
    }
  | { type: 'run:error'; error: string };
