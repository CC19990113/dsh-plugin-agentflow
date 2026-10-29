// 后端 API 封装。所有失败都抛 Error，由调用方 toast。
// 多画布：列表 / 画布 CRUD 走 /api/boards*；节点、运行、生成命令都带 ?board=<id>。

import type {
  Board,
  BoardMeta,
  BridgeStatus,
  ConfigInfo,
  FlowNode,
  McpServer,
  ModelCatalog,
  PresetRow,
  Skill,
} from './types';

/** 一条斜杠命令（对应 <dataDir>/commands/<name>.json） */
export interface CommandRecord {
  name: string;
  board: string;
  /** 画布名；画布已删但命令还留着时为 null */
  boardName: string | null;
  boardExists: boolean;
  createdAt: number;
  file: string;
}

/** POST /api/export/command 的成功返回 */
export interface ExportCommandResult {
  ok: boolean;
  name: string;
  board: string;
  boardName: string;
  file: string;
  /** true = 覆盖了同名旧命令（createdAt 沿用第一次） */
  replaced: boolean;
}

/**
 * 内联模式适配：画布被编进 DSH 插件后不再与后端同源，宿主会通过
 * `globalThis.__AGENTFLOW_HOST__.apiBase` 注入后端地址（如 http://127.0.0.1:8791）。
 * 独立浏览器打开时没有这个全局桥，保持相对路径走 vite 代理。
 */
export function apiUrl(url: string): string {
  try {
    const bridge = (globalThis as { __AGENTFLOW_HOST__?: { apiBase?: unknown } })
      .__AGENTFLOW_HOST__;
    const base = typeof bridge?.apiBase === 'string' ? bridge.apiBase.replace(/\/+$/, '') : '';
    return `${base}${url}`;
  } catch {
    return url;
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(url), {
    ...init,
    headers:
      init?.body != null
        ? { 'Content-Type': 'application/json', ...(init?.headers || {}) }
        : init?.headers,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error || JSON.stringify(j);
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(`HTTP ${res.status} ${detail}`.slice(0, 300));
  }
  return res.json() as Promise<T>;
}

/** 落库前清掉纯前端字段（delta 是流式预览，不是配置） */
function boardPayload(board: Board): Board {
  return {
    ...board,
    nodes: board.nodes.map((n) => {
      const rest = { ...n };
      delete rest.delta;
      return rest;
    }),
  };
}

/** 节点 / 运行 / 导出类接口都要带画布上下文；不传时后端用索引里的第一张 */
function withBoard(url: string, boardId?: string | null): string {
  if (!boardId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}board=${encodeURIComponent(boardId)}`;
}

export const api = {
  // ---------- 画布 ----------
  listBoards: () => req<{ boards: BoardMeta[] }>('/api/boards'),

  listPresets: () => req<{ presets: PresetRow[] }>('/api/presets'),

  getBoard: (id: string) =>
    req<{ board: Board }>(`/api/boards/${encodeURIComponent(id)}`),

  createBoard: (payload: { name: string; presetId?: string }) =>
    req<{ board: Board; meta: BoardMeta }>('/api/boards', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 从预设生成单卡片画布；服务端 P1 未实现时回 501 */
  importPreset: (presetId: string) =>
    req<{ board: Board; reused?: boolean }>('/api/boards/import-preset', {
      method: 'POST',
      body: JSON.stringify({ presetId }),
    }),

  /** 整体保存；body 用 { board } 包一层（契约也允许裸 board） */
  putBoard: (id: string, board: Board) =>
    req<{ ok: boolean; meta: BoardMeta }>(`/api/boards/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ board: boardPayload(board) }),
    }),

  // ---------- 草稿（手动保存前先存一份未落定修改） ----------
  putDraft: (id: string, board: Board) =>
    req<{ ok: boolean; updatedAt: number }>(`/api/boards/${encodeURIComponent(id)}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ board: boardPayload(board) }),
    }),

  /** 读草稿；没有草稿时后端回 404（调用方自己判断） */
  getDraft: (id: string) =>
    req<{ draft: Board; updatedAt: number }>(`/api/boards/${encodeURIComponent(id)}/draft`),

  deleteDraft: (id: string) =>
    req<{ ok: boolean }>(`/api/boards/${encodeURIComponent(id)}/draft`, {
      method: 'DELETE',
    }),

  /** 只改元信息（目前只有 name） */
  patchBoard: (id: string, patch: { name?: string }) =>
    req<{ ok: boolean; meta: BoardMeta }>(`/api/boards/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteBoard: (id: string) =>
    req<{ ok: boolean }>(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ---------- 全局（与画布无关） ----------
  getSkills: () => req<{ dirs: string[]; skills: Skill[] }>('/api/skills'),

  getMcp: () => req<{ servers: McpServer[] }>('/api/mcp'),

  getConfig: () => req<ConfigInfo>('/api/config'),

  /** DSH 的模型目录：走 bridge，服务端透传内核 ≤10s 的缓存 */
  getModels: (refresh = false) =>
    req<ModelCatalog>(`/api/models${refresh ? '?refresh=1' : ''}`),

  /** bridge 连接状态：模型通道只有 DSH 内核这一条 */
  getBridge: () => req<BridgeStatus>('/api/bridge'),

  putConfig: (cfg: Record<string, unknown>) =>
    req<{ ok: boolean; mock: boolean }>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(cfg),
    }),

  /** 生成斜杠命令；boardId 决定挂哪张画布，name 是自定义命令名（缺省按画布 id 生成） */
  exportCommand: (boardId?: string | null, name?: string) =>
    req<ExportCommandResult>(withBoard('/api/export/command', boardId), {
      method: 'POST',
      body: JSON.stringify(name ? { name } : {}),
    }),

  /** 全部命令（带画布名与画布是否还在） */
  listCommands: () => req<{ commands: CommandRecord[] }>('/api/commands'),

  /** 删命令；不存在时后端回 404 */
  deleteCommand: (name: string) =>
    req<{ ok: boolean; name: string }>(`/api/commands/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),

  /** 人工确认：通过或打回 */
  verify: (id: string, pass: boolean, reason?: string, boardId?: string | null) =>
    req<FlowNode>(withBoard(`/api/verify/${encodeURIComponent(id)}`, boardId), {
      method: 'POST',
      body: JSON.stringify({ pass, reason }),
    }),
};
