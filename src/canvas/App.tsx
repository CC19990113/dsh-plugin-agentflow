import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  FlaskConical,
  Loader2,
  Moon,
  Plus,
  Save,
  Settings,
  Sun,
} from 'lucide-react';
import { Button, ConfigProvider, Input, Modal, Tag, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { api, apiUrl } from './api';
import { useRun } from './useRun';
import type {
  Board,
  BoardMeta,
  BridgeStatus,
  ConfigInfo,
  Edge,
  FlowNode,
  McpServer,
  ModelCatalog,
  PresetRow,
  RunEvent,
  Skill,
} from './types';
import FlowCanvas from './components/FlowCanvas';
import NodePanel from './components/NodePanel';
import SettingsDialog from './components/SettingsDialog';
import ExportPresetDialog from './components/ExportPresetDialog';

type View = 'list' | 'board';

const LINE = 'border-[#E3E4DF] dark:border-[#262724]';
const INK = 'text-[#1B1B18] dark:text-[#e8e8e4]';
const MUTED = 'text-[#6b6b66] dark:text-[#8b8b85]';
const FAINT = 'text-[#8b8b85] dark:text-[#8b8b85]';

/* ------------------------------------------------------------------ */
/* 内联模式适配：画布跑在 DSH 插件里时，宿主通过全局桥接管主题/画布/API   */
/* ------------------------------------------------------------------ */

/** CanvasHost 在挂载前设置的全局桥；独立浏览器打开时为 undefined */
interface InlineHostBridge {
  apiBase?: string;
  theme?: 'light' | 'dark';
  boardId?: string;
  remote?: boolean;
}

function readHostBridge(): InlineHostBridge | null {
  try {
    const bridge = (globalThis as { __AGENTFLOW_HOST__?: InlineHostBridge }).__AGENTFLOW_HOST__;
    return bridge && typeof bridge === 'object' ? bridge : null;
  } catch {
    return null;
  }
}

/** 内联模式：主题、画布切换、API 地址都由宿主接管 */
function isInlineMode(): boolean {
  return readHostBridge()?.remote === true;
}

export default function App() {
  // ---------- 视图 / 画布 ----------
  const [view, setView] = useState<View>('list');
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [presets, setPresets] = useState<PresetRow[]>([]);
  // 每张画布的对话入口节点名（列表接口不带节点，loadLists 里单独读详情算出来）
  const [boardEntries, setBoardEntries] = useState<Record<string, string | null>>({});
  const [listsLoading, setListsLoading] = useState(true);
  const [currentBoardId, setCurrentBoardId] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [boardName, setBoardName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingPresetId, setCreatingPresetId] = useState<string | null>(null);

  // 新建 / 重命名画布的临时状态
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Esc 取消更名：blur 会走提交逻辑，用标记跳过这次提交
  const renameCancelRef = useRef(false);
  const boardNameCancelRef = useRef(false);

  // ---------- 全局数据 ----------
  const [skills, setSkills] = useState<Skill[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // ---------- 手动保存 / 草稿 / 离开提醒 ----------
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // dirty 的同步副本：blur 触发的 flush 和紧随其后的 click 在同一拍里，
  // 只读 state 会读到上一帧的 false，守卫就会漏弹
  const dirtyRef = useRef(false);
  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
  }, []);
  const clearDirty = useCallback(() => {
    dirtyRef.current = false;
    setDirty(false);
  }, []);
  const openSeqRef = useRef(0);
  // saveNow 要拿「按 ⌘S 那一刻」的最新画布：state 闭包可能落后一次渲染
  const boardRef = useRef<Board | null>(null);
  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  // 编辑即自动落库（防抖 200ms）
  useEffect(() => {
    if (!board || view !== 'board') return;
    const timer = window.setTimeout(() => {
      void api.putBoard(board.id, board).catch((err) => {
        console.warn('[agentflow] 自动保存失败：', err);
      });
      setBoards((prev) =>
        prev.map((b) => (b.id === board.id ? { ...b, presetOutdated: true } : b))
      );
    }, 200);
    return () => window.clearTimeout(timer);
  }, [board, view]);

  // 兜底：切走/关闭时防抖还没到就整张立即写一次（keepalive，不弹任何提示）
  useEffect(() => {
    const flushOnLeave = () => {
      const current = boardRef.current;
      if (!current) return;
      try {
        void fetch(apiUrl(`/api/boards/${encodeURIComponent(current.id)}`), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ board: current }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* 发不出去也没别的办法 */
      }
    };
    window.addEventListener('pagehide', flushOnLeave);
    return () => window.removeEventListener('pagehide', flushOnLeave);
  }, []);

  // 主题优先级：
  //   内联模式（DSH 插件）→ 宿主桥里的 theme，之后跟 agentflow-theme 事件走；
  //   独立浏览器 → sessionStorage > URL ?theme= > 系统偏好（保持旧行为）。
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const bridge = readHostBridge();
    if (bridge?.remote) {
      if (bridge.theme === 'dark') return true;
      if (bridge.theme === 'light') return false;
      try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
      } catch {
        return false;
      }
    }
    try {
      // 旧版本把选择持久化在 localStorage，会让「跟 DSH 走」失效，启动时清掉
      localStorage.removeItem('agentflow-theme');
    } catch {
      /* 忽略 */
    }
    try {
      const saved = sessionStorage.getItem('agentflow-theme');
      if (saved === 'dark') return true;
      if (saved === 'light') return false;
    } catch {
      /* 隐私模式读不了就继续往下走 */
    }
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('theme');
      if (fromUrl === 'dark') return true;
      if (fromUrl === 'light') return false;
    } catch {
      /* 忽略 */
    }
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (isInlineMode()) {
      // 内联模式：.dark 挂在画布根容器上（见 render），不碰 documentElement，
      // 也不写 sessionStorage —— DSH 宿主页面和持久化都不该被画布改。
      window.dispatchEvent(new Event('themechange'));
      return;
    }
    document.documentElement.classList.toggle('dark', darkMode);
    try {
      sessionStorage.setItem('agentflow-theme', darkMode ? 'dark' : 'light');
    } catch {
      /* 隐私模式写不了就算了 */
    }
    // 通知画布层（React Flow 的 Background/MiniMap 颜色要跟着换）
    window.dispatchEvent(new Event('themechange'));
  }, [darkMode]);

  // 内联模式：宿主主题变化时派发 agentflow-theme，画布只跟事件走
  useEffect(() => {
    if (!isInlineMode()) return;
    const onTheme = (event: Event) => {
      const theme = (event as CustomEvent<{ theme?: string }>).detail?.theme;
      if (theme === 'dark') setDarkMode(true);
      else if (theme === 'light') setDarkMode(false);
    };
    window.addEventListener('agentflow-theme', onTheme);
    return () => window.removeEventListener('agentflow-theme', onTheme);
  }, []);

  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  /** 把节点字段改动落到本地状态，服务端另发 */
  const patchLocal = useCallback((id: string, patch: Partial<FlowNode>) => {
    setBoard((b) =>
      b ? { ...b, nodes: b.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) } : b
    );
  }, []);

  // 当前画布 id 的 ref：SSE 回调与节点操作要拿最新值，不能依赖闭包里的旧 state
  const boardIdRef = useRef<string | null>(null);
  // 正在跑的那条 SSE 属于哪张画布：切走之后不能把事件打到别的画布上
  const runBoardIdRef = useRef<string | null>(null);

  useEffect(() => {
    boardIdRef.current = currentBoardId;
  }, [currentBoardId]);

  // 顶栏画布名跟随当前画布（只在名字变化时同步，避免打字被打断）
  useEffect(() => {
    setBoardName(board?.name ?? '');
  }, [board?.id, board?.name]);

  // ---------- 列表：画布 + 预设 ----------
  const loadLists = useCallback(
    async (silent = false) => {
      if (!silent) setListsLoading(true);
      const [listRes, presetRes] = await Promise.allSettled([
        api.listBoards(),
        api.listPresets(),
      ]);
      if (listRes.status === 'fulfilled') {
        const metas = listRes.value.boards;
        setBoards(metas);
        // 列表接口只有 nodeCount：逐张读一次详情，才能显示「对话入口」
        const details = await Promise.allSettled(metas.map((m) => api.getBoard(m.id)));
        const entries: Record<string, string | null> = {};
        details.forEach((detail, i) => {
          if (detail.status === 'fulfilled') {
            entries[metas[i].id] = entryNodeName(detail.value.board);
          }
        });
        setBoardEntries(entries);
      } else {
        notify(`加载画布列表失败：${(listRes.reason as Error).message}`, 'err');
      }
      if (presetRes.status === 'fulfilled') setPresets(presetRes.value.presets);
      else notify(`加载预设列表失败：${(presetRes.reason as Error).message}`, 'err');
      if (!silent) setListsLoading(false);
    },
    [notify]
  );

  // ---------- 初始加载 ----------
  useEffect(() => {
    void loadLists();
    void api.getSkills().then((r) => setSkills(r.skills)).catch(() => {});
    void api.getMcp().then((r) => setServers(r.servers)).catch(() => {});
    void api.getConfig().then(setConfig).catch(() => {});
    void api.getModels().then(setCatalog).catch(() => {});
    void api.getBridge().then(setBridge).catch(() => {});
  }, [loadLists]);

  // 打开任意节点面板时顺手刷新一次模型目录与 bridge 状态（30 秒节流）：
  // DSH 里刚加的供应商不用重启就能出现在下拉里。
  const catalogFetchedAt = useRef(0);
  useEffect(() => {
    if (!selectedId) return;
    if (Date.now() - catalogFetchedAt.current < 30_000) return;
    catalogFetchedAt.current = Date.now();
    void api.getModels(true).then(setCatalog).catch(() => {});
    void api.getBridge().then(setBridge).catch(() => {});
  }, [selectedId]);

  // ---------- SSE 事件 ----------
  const onEvent = useCallback(
    (ev: RunEvent) => {
      // 事件属于另一张画布（用户跑图后切走了）：只清运行标记，不改当前画布
      const stale =
        runBoardIdRef.current != null && boardIdRef.current !== runBoardIdRef.current;
      if (ev.type === 'run:end' || ev.type === 'run:error') runBoardIdRef.current = null;
      if (stale) return;

      switch (ev.type) {
        case 'node:start':
          patchLocal(ev.id, { status: 'running' });
          break;
        case 'node:delta':
          // 流式预览：累加到节点的 delta 上，done 到了就用 content 覆盖
          setBoard((b) =>
            b
              ? {
                  ...b,
                  nodes: b.nodes.map((n) =>
                    n.id === ev.id ? { ...n, delta: (n.delta || '') + ev.chunk } : n
                  ),
                }
              : b
          );
          break;
        case 'node:done':
          patchLocal(ev.id, {
            status: ev.status ?? 'done',
            content: ev.content,
            usage: ev.usage,
            verdict: ev.verdict ?? null,
            error: null,
            delta: undefined,
          });
          break;
        case 'node:failed':
          patchLocal(ev.id, { status: 'failed', error: '该节点所有模型都失败' });
          break;
        case 'node:blocked':
          patchLocal(ev.id, { status: 'blocked' });
          break;
        case 'node:retry':
          setBoard((b) =>
            b
              ? { ...b, nodes: b.nodes.map((n) => (n.id === ev.id ? { ...n, delta: undefined } : n)) }
              : b
          );
          notify(`${ev.id} 换 ${ev.model} 重试：${ev.error}`, 'err');
          break;
        case 'run:end': {
          const { done, failed, blocked, review } = ev.summary;
          const bits = [`完成 ${done.length}`];
          if (review.length) bits.push(`待确认 ${review.length}`);
          if (failed.length) bits.push(`失败 ${failed.length}`);
          if (blocked.length) bits.push(`阻塞 ${blocked.length}`);
          notify(bits.join('，'), failed.length || blocked.length ? 'err' : 'ok');
          break;
        }
        case 'run:error':
          notify(`运行出错：${ev.error}`, 'err');
          break;
      }
    },
    [patchLocal, notify]
  );

  const { running, run, stop } = useRun(onEvent);

  const startRun = useCallback(
    (targets?: string[]) => {
      const id = boardIdRef.current;
      if (!id) return;
      runBoardIdRef.current = id;
      void run(targets, id);
    },
    [run]
  );

  const stopRun = useCallback(() => {
    runBoardIdRef.current = null;
    stop();
  }, [stop]);

  // ---------- 进入 / 返回画布 ----------
  const openBoard = useCallback(
    async (id: string) => {
      const seq = ++openSeqRef.current;
      setView('board');
      setCurrentBoardId(id);
      setBoard(null);
      setBoardName('');
      setSelectedId(null);
      setExportOpen(false);
      clearDirty();
      const boardRes = await api.getBoard(id).then((value) => ({ status: 'fulfilled' as const, value })).catch((reason) => ({ status: 'rejected' as const, reason }));
      if (seq !== openSeqRef.current) return;

      if (boardRes.status === 'rejected') {
        notify(`打开画布失败：${(boardRes.reason as Error).message}`, 'err');
        setView('list');
        setCurrentBoardId(null);
        clearDirty();
        void loadLists(true);
        return;
      }
      setBoard(boardRes.value.board);
    },
    [loadLists, notify]
  );

  // 外部跳转：内联模式读宿主桥的 boardId；独立浏览器读 URL ?board=<id>
  // （设置页「编辑」在旧 iframe 版本里就是从 DSH 里跳过来的）。
  const initialBoardRef = useRef<string | null>((() => {
    const bridge = readHostBridge();
    if (bridge?.remote && bridge.boardId) return bridge.boardId;
    return typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('board');
  })());
  useEffect(() => {
    const target = initialBoardRef.current;
    if (!target) return;
    initialBoardRef.current = null;
    void openBoard(target);
  }, [openBoard]);

  // 内联模式：宿主切换画布时派发 agentflow-board，画布跟事件打开对应画布
  useEffect(() => {
    if (!isInlineMode()) return;
    const onBoard = (event: Event) => {
      const next = (event as CustomEvent<{ boardId?: string }>).detail?.boardId;
      if (!next || next === boardIdRef.current) return;
      void openBoard(next);
    };
    window.addEventListener('agentflow-board', onBoard);
    return () => window.removeEventListener('agentflow-board', onBoard);
  }, [openBoard]);

  const performBackToList = useCallback(() => {
    openSeqRef.current += 1;
    setView('list');
    setBoard(null);
    setCurrentBoardId(null);
    setSelectedId(null);
    setExportOpen(false);
    clearDirty();
    void loadLists(true);
  }, [loadLists]);

  function backToList() {
    performBackToList();
  }

  /** 从列表进入另一张画布 */
  function requestOpenBoard(id: string) {
    void openBoard(id);
  }

  // ---------- 手动保存（整张画布 PUT） ----------
  /** 只把画布写回服务端（验证/导出前用，不动预设） */
  const flushBoard = useCallback(async (): Promise<boolean> => {
    const current = boardRef.current;
    if (!current) return false;
    try {
      await api.putBoard(current.id, current);
      clearDirty();
      return true;
    } catch (err) {
      notify(`保存画布失败：${(err as Error).message}`, 'err');
      return false;
    }
  }, [notify, clearDirty]);

  /** 「保存」= 画布落库 + 生成/覆盖当前预设（预设名沿用画布名） */
  const saveNow = useCallback(async (): Promise<boolean> => {
    const current = boardRef.current;
    if (!current || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      await api.putBoard(current.id, current);
      await api.exportPreset(current.id, current.name);
      clearDirty();
      setBoards((prev) =>
        prev.map((b) =>
          b.id === current.id
            ? { ...b, name: current.name, nodeCount: current.nodes.length, presetOutdated: false, updatedAt: Date.now() }
            : b
        )
      );
      notify('已保存，预设已更新');
      return true;
    } catch (err) {
      notify(`保存失败：${(err as Error).message}`, 'err');
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [notify, clearDirty]);

  // ⌘S / Ctrl+S 保存；有未保存修改时关页给原生提示
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 's') {
        e.preventDefault();
        if (view === 'board') {
          // 延后一拍：NodePanel 收到同一个快捷键后会先 flush 防抖中的输入
          window.setTimeout(() => void saveNow(), 0);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveNow, view]);

  // 验证 AgentFlow：先落库再跑，否则服务端验证的是旧配置
  const verifyWorkflow = useCallback(
    async (targets?: string[]) => {
      if (!board) return;
      if (dirtyRef.current) {
        const ok = await flushBoard();
        if (!ok) return;
      }
      startRun(targets);
    },
    [board, flushBoard, startRun]
  );

  // 导出前先保存，失败则阻断导出
  const openExport = useCallback(async () => {
    if (!board) return;
    if (dirtyRef.current) {
      const ok = await flushBoard();
      if (!ok) return;
    }
    setExportOpen(true);
  }, [board, flushBoard]);

  // ---------- 本地编辑（统一 setDirty，不再自动落库） ----------
  const patchNode = useCallback(
    (id: string, patch: Partial<FlowNode>) => {
      patchLocal(id, patch);
      markDirty();
    },
    [patchLocal]
  );

  const changeEdges = useCallback((nextEdges: Edge[]) => {
    setBoard((b) => (b ? { ...b, edges: nextEdges } : b));
    markDirty();
  }, []);

  const moveNode = useCallback(
    (id: string, x: number, y: number) => {
      if (!board) return;
      setBoard({
        ...board,
        nodes: board.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
      });
      markDirty();
    },
    [board]
  );

  const derive = useCallback(
    (id: string, dir: 'prev' | 'next') => {
      if (!board) return;
      const parent = board.nodes.find((n) => n.id === id);
      if (!parent) return;
      // 新卡默认沿用父卡的 provider/model；父卡没配时退回目录里第一个可用模型，
      // 否则会建出一张 provider 为空、验证必失败的卡。
      const firstProvider = catalog?.providers.find((p) => p.models.length);
      const provider = parent.provider || firstProvider?.id || '';
      const model = parent.model || firstProvider?.models[0]?.id || '';
      const nextId = newLocalNodeId(board.nodes);
      const created: FlowNode = {
        id: nextId,
        label: dir === 'next' ? '下游卡片' : '上游卡片',
        type: 'llm',
        x: dir === 'next' ? parent.x + 360 : parent.x - 360,
        y: parent.y,
        provider,
        model,
        reasoningEffort: '',
        fallback: [],
        fallbackEfforts: {},
        task: '',
        criteria: '',
        skills: [],
        tools: [],
        verify: '',
        content: '',
        status: 'idle',
        usage: null,
        error: null,
        verdict: null,
      };
      setBoard({
        ...board,
        nodes: [...board.nodes, created],
        edges: [
          ...board.edges,
          dir === 'next' ? { from: id, to: nextId } : { from: nextId, to: id },
        ],
      });
      setSelectedId(nextId);
      markDirty();
      notify(dir === 'next' ? '已派生下游卡片（未保存）' : '已添加上游卡片（未保存）');
    },
    [board, catalog, notify]
  );

  const connect = useCallback(
    (from: string, to: string) => {
      if (!board || from === to) return;
      // 根节点（调度卡）是流程起点，不能有上游
      const target = board.nodes.find((n) => n.id === to);
      if (target?.type === 'orchestrator') {
        notify('根节点是对话入口，不能有上游节点', 'err');
        return;
      }
      if (board.edges.some((e) => e.from === from && e.to === to)) return;
      if (createsCycle(board.edges, from, to)) {
        notify('这条连线会形成环，已忽略', 'err');
        return;
      }
      setBoard({ ...board, edges: [...board.edges, { from, to }] });
      markDirty();
    },
    [board, notify]
  );

  const deleteNode = useCallback(
    (id: string) => {
      if (!board) return;
      setBoard({
        ...board,
        nodes: board.nodes.filter((n) => n.id !== id),
        edges: board.edges.filter((e) => e.from !== id && e.to !== id),
      });
      setSelectedId(null);
      markDirty();
      notify('已删除（未保存）');
    },
    [board, notify]
  );

  const confirmVerify = useCallback(
    async (id: string, pass: boolean) => {
      // 人工确认是服务端动作：先把本地改动落库，别对着旧画布打标
      if (dirtyRef.current) {
        const ok = await flushBoard();
        if (!ok) return;
      }
      try {
        const node = await api.verify(id, pass, undefined, boardIdRef.current);
        patchLocal(id, { status: node.status, verdict: node.verdict });
        notify(pass ? '已通过' : '已打回，可以改完再跑');
      } catch (err) {
        notify(`操作失败：${(err as Error).message}`, 'err');
      }
    },
    [patchLocal, notify, flushBoard]
  );

  // 模型选项全部来自 DSH 的模型目录（/api/models），不再有本地 provider 清单
  const selected = useMemo(
    () => board?.nodes.find((n) => n.id === selectedId) ?? null,
    [board, selectedId]
  );

  // ---------- 列表操作 ----------
  const boardPresetIds = useMemo(
    () => new Set(boards.map((b) => b.presetId).filter((x): x is string => Boolean(x))),
    [boards]
  );
  // 已经有画布的预设不再重复展示「创建画布」
  const pendingPresets = useMemo(
    () => presets.filter((p) => !boardPresetIds.has(p.id)),
    [presets, boardPresetIds]
  );

  function openNewBoard() {
    setNewName('');
    setNewOpen(true);
  }

  async function createBlankBoard() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const res = await api.createBoard({ name });
      openSeqRef.current += 1;
      setNewOpen(false);
      setNewName('');
      setBoard(res.board);
      setCurrentBoardId(res.board.id);
      setSelectedId(null);
      clearDirty();
      setView('board');
      void loadLists(true);
    } catch (err) {
      notify(`新建画布失败：${(err as Error).message}`, 'err');
    } finally {
      setCreating(false);
    }
  }

  async function createFromPreset(preset: PresetRow) {
    if (creatingPresetId) return;
    setCreatingPresetId(preset.id);
    try {
      const res = await api.importPreset(preset.id);
      notify(res.reused ? `已有这张画布：${preset.name}` : `已从预设创建画布：${preset.name}`);
      openSeqRef.current += 1;
      setBoard(res.board);
      setCurrentBoardId(res.board.id);
      setSelectedId(null);
      clearDirty();
      setView('board');
      void loadLists(true);
    } catch (err) {
      const msg = (err as Error).message;
      // 服务端 P1 还没上线时是 501：给个明确说法，而不是裸 HTTP 错误
      if (msg.includes('HTTP 501')) {
        notify('创建画布功能还没上线（服务端 P1 未完成）', 'err');
      } else {
        notify(`创建画布失败：${msg}`, 'err');
      }
    } finally {
      setCreatingPresetId(null);
    }
  }

  function beginRename(target: BoardMeta) {
    setRenamingId(target.id);
    setRenameValue(target.name);
  }

  async function commitRename(target: BoardMeta) {
    if (renamingId !== target.id) return;
    const cancelled = renameCancelRef.current;
    renameCancelRef.current = false;
    setRenamingId(null);
    if (cancelled) {
      setRenameValue(target.name);
      return;
    }
    const next = renameValue.trim();
    if (!next || next === target.name) return;
    try {
      const res = await api.patchBoard(target.id, { name: next });
      setBoards((prev) =>
        prev.map((b) =>
          b.id === target.id ? { ...b, name: next, updatedAt: res.meta?.updatedAt ?? b.updatedAt } : b
        )
      );
      if (board?.id === target.id) setBoard((b) => (b ? { ...b, name: next } : b));
      notify('画布已重命名');
    } catch (err) {
      notify(`重命名失败：${(err as Error).message}`, 'err');
    }
  }

  async function confirmDelete(target: BoardMeta) {
    if (boards.length <= 1) {
      notify('至少要保留一张画布', 'err');
      return;
    }
    if (!window.confirm(`删除画布《${target.name}》？里面的节点会一起删掉，且不可恢复。`)) return;
    try {
      await api.deleteBoard(target.id);
      notify('画布已删除');
      await loadLists(true);
    } catch (err) {
      notify(`删除失败：${(err as Error).message}`, 'err');
    }
  }

  async function commitBoardName() {
    if (!board) return;
    const cancelled = boardNameCancelRef.current;
    boardNameCancelRef.current = false;
    if (cancelled) {
      setBoardName(board.name);
      return;
    }
    const next = boardName.trim();
    if (!next) {
      setBoardName(board.name);
      return;
    }
    if (next === board.name) return;
    try {
      const res = await api.patchBoard(board.id, { name: next });
      setBoard((b) => (b ? { ...b, name: next } : b));
      setBoards((prev) =>
        prev.map((b) =>
          b.id === board.id ? { ...b, name: next, updatedAt: res.meta?.updatedAt ?? b.updatedAt } : b
        )
      );
      notify('画布已重命名');
    } catch (err) {
      setBoardName(board.name);
      notify(`重命名失败：${(err as Error).message}`, 'err');
    }
  }

  // ---------- 渲染 ----------
  // 画布根容器：CSS 作用域（.af-canvas）、主题类（.dark）和 antd 弹层都挂在这里。
  // 内联模式下弹层不能挂 body，否则拿不到 .dark 与画布 CSS 变量。
  const canvasRootRef = useRef<HTMLDivElement>(null);

  return (
    <ConfigProvider
      locale={zhCN}
      getPopupContainer={() => canvasRootRef.current ?? document.body}
      theme={{
        algorithm: darkMode ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: '#24543F',
          borderRadius: 7,
          fontSize: 15,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', ui-sans-serif, sans-serif",
        },
        components: {
          Drawer: { paddingLG: 20 },
          Modal: { borderRadiusLG: 12 },
          Card: { borderRadiusLG: 10 },
        },
      }}
    >
      <div
        ref={canvasRootRef}
        className={`af-canvas flex h-full flex-col${darkMode ? ' dark' : ''}`}
      >
        {view === 'list' ? (
          <header
            className={`flex h-14 shrink-0 items-center gap-3 border-b ${LINE} bg-[#FCFCFA] px-5 dark:bg-[#17181b]`}
          >
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-[4px] bg-[#24543F] text-white">
                ◈
              </span>
              <span className={`text-[17px] font-semibold tracking-tight ${INK}`}>
                AgentFlow
              </span>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button type="primary" icon={<Plus size={14} />} onClick={openNewBoard}>
                新建画布
              </Button>
              <Button
                icon={darkMode ? <Sun size={14} /> : <Moon size={14} />}
                onClick={() => setDarkMode((v) => !v)}
                title={darkMode ? '切到浅色' : '切到深色'}
              />
              <Button icon={<Settings size={14} />} onClick={() => setSettingsOpen(true)}>
                设置
              </Button>
            </div>
          </header>
        ) : (
          <header
            className={`flex h-14 shrink-0 items-center gap-2 border-b ${LINE} bg-[#FCFCFA] px-4 dark:bg-[#17181b]`}
          >
            <button
              type="button"
              onClick={backToList}
              title="返回画布列表"
              className={`flex shrink-0 items-center gap-1 rounded-[4px] px-2 py-1.5 text-[12px] transition-colors hover:bg-[#EFEFEA] dark:hover:bg-[#232421] ${MUTED}`}
            >
              <ArrowLeft size={14} />
              返回列表
            </button>
            <div className="h-5 w-px shrink-0 bg-[#E3E4DF] dark:bg-[#2c2d29]" />
            <input
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              onBlur={() => void commitBoardName()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  boardNameCancelRef.current = true;
                  e.currentTarget.blur();
                }
              }}
              disabled={!board}
              placeholder="画布名称"
              aria-label="画布名称"
              className={`min-w-0 max-w-[280px] flex-1 rounded-[3px] border-0 bg-transparent px-1 py-1 text-[16px] font-semibold tracking-tight outline-none placeholder:text-[#a8a8a0] focus-visible:ring-2 focus-visible:ring-[#24543F]/30 disabled:bg-transparent dark:placeholder:text-[#6f6f68] dark:focus-visible:ring-[#6aa583]/40 ${INK}`}
            />

            {dirty && (
              <span
                title="有未保存的修改"
                aria-label="有未保存的修改"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#B4451F] dark:bg-[#e08a6a]"
              />
            )}

            <div className="ml-auto flex items-center gap-2">
              <Button
                icon={<Save size={14} />}
                disabled={!board}
                loading={saving}
                onClick={() => void saveNow()}
                title="保存画布并更新预设（⌘S / Ctrl+S）"
              >
                保存
              </Button>

              {running ? (
                <Button
                  danger
                  icon={<Loader2 size={14} className="animate-spin" />}
                  onClick={stopRun}
                >
                  停止
                </Button>
              ) : (
                <Button
                  type="primary"
                  icon={<FlaskConical size={14} />}
                  disabled={!board}
                  onClick={() => void verifyWorkflow()}
                  title="先保存，再跑一遍验证（会真实调用模型）"
                >
                  验证 AgentFlow
                </Button>
              )}

              <Button
                icon={<Download size={14} />}
                disabled={!board}
                onClick={() => void openExport()}
              >
                导出预设
              </Button>

              <Button
                icon={darkMode ? <Sun size={14} /> : <Moon size={14} />}
                onClick={() => setDarkMode((v) => !v)}
                title={darkMode ? '切到浅色' : '切到深色'}
              />

              <Button icon={<Settings size={14} />} onClick={() => setSettingsOpen(true)}>
                设置
              </Button>
            </div>
          </header>
        )}

        
        {view === 'list' ? (
          <main className="min-h-0 flex-1 overflow-y-auto bg-[#F4F5F2] px-6 py-7 dark:bg-[#111214]">
            <div className="mx-auto w-full max-w-[1080px]">
              <div className="mb-5">
                <h1 className={`text-[20px] font-semibold tracking-tight ${INK}`}>画布</h1>
                <p className={`mt-1 text-[12px] leading-[1.6] ${MUTED}`}>
                  每张画布对应一个 DSH 预设；编辑会自动保存，点「保存」才会更新/生成预设。
                </p>
              </div>

              {listsLoading && boards.length === 0 ? (
                <div className={`py-16 text-center text-[13px] ${MUTED}`}>
                  正在加载画布…
                </div>
              ) : (
                <>
                  {boards.length === 0 ? (
                    <div
                      className={`rounded-[8px] border border-dashed ${LINE} py-14 text-center text-[13px] ${MUTED}`}
                    >
                      还没有画布，点右上角「新建画布」开始。
                    </div>
                  ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {boards.map((item) => {
                      const preset = item.presetId
                        ? presets.find((p) => p.id === item.presetId)
                        : null;
                      return (
                        <article
                          key={item.id}
                          className={`flex min-h-[150px] flex-col rounded-[8px] border ${LINE} bg-[#FCFCFA] p-4 dark:bg-[#17181B]`}
                        >
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              {renamingId === item.id ? (
                                <Input
                                  size="small"
                                  autoFocus
                                  maxLength={60}
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onBlur={() => void commitRename(item)}
                                  onPressEnter={(e) => e.currentTarget.blur()}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                      renameCancelRef.current = true;
                                      e.currentTarget.blur();
                                    }
                                  }}
                                  aria-label={`重命名画布 ${item.name}`}
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => requestOpenBoard(item.id)}
                                  title={item.name}
                                  className="block max-w-full text-left"
                                >
                                  <h2 className={`truncate text-[15px] font-semibold ${INK}`}>
                                    {item.name}
                                  </h2>
                                </button>
                              )}
                              <p className={`mt-1 text-[11px] leading-[1.6] ${FAINT}`}>
                                {item.nodeCount} 个节点 · 更新于 {formatUpdated(item.updatedAt)}
                              </p>
                              {boardEntries[item.id] !== undefined && (
                                <p
                                  className={`mt-0.5 truncate text-[11px] leading-[1.6] ${MUTED}`}
                                  title={
                                    boardEntries[item.id] ||
                                    '没有调度卡，首次导出会自动补一张'
                                  }
                                >
                                  对话入口：
                                  {boardEntries[item.id] ||
                                    '未设置（首次导出会自动补一张调度卡）'}
                                </p>
                              )}
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <Tag
                                color={preset ? 'blue' : 'default'}
                                style={{ marginInlineEnd: 0 }}
                              >
                                {preset ? preset.name : '自定义'}
                              </Tag>
                              {item.presetOutdated && (
                                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                                  预设未更新
                                </Tag>
                              )}
                              {item.hasDraft && (
                                <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                                  草稿
                                </Tag>
                              )}
                            </div>
                          </div>

                          <div className="mt-auto flex flex-wrap items-center gap-1 pt-3">
                            <Button
                              size="small"
                              type="primary"
                              onClick={() => requestOpenBoard(item.id)}
                            >
                              编辑
                            </Button>
                            <Button size="small" type="text" onClick={() => beginRename(item)}>
                              重命名
                            </Button>
                            <Button
                              size="small"
                              type="text"
                              danger
                              disabled={boards.length <= 1}
                              title={boards.length <= 1 ? '至少要保留一张画布' : undefined}
                              onClick={() => void confirmDelete(item)}
                            >
                              删除
                            </Button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  )}

                  {pendingPresets.length > 0 && (
                    <>
                      <div className="mb-3 mt-8 flex flex-wrap items-baseline gap-2">
                        <h2 className={`text-[13px] font-semibold ${INK}`}>
                          还没有画布的预设
                        </h2>
                        <span className={`text-[11px] ${FAINT}`}>
                          从预设生成一张单卡片画布，再继续编辑
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {pendingPresets.map((preset) => (
                          <article
                            key={preset.id}
                            className={`flex min-h-[150px] flex-col rounded-[8px] border border-dashed ${LINE} bg-[#F9F9F6] p-4 dark:bg-[#151617]`}
                          >
                            <div className="flex items-start gap-2">
                              <h2
                                className={`min-w-0 flex-1 truncate text-[15px] font-semibold ${INK}`}
                                title={preset.name}
                              >
                                {preset.name}
                              </h2>
                              <Tag style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                                {preset.source === 'bundle' ? 'bundle' : '自定义'}
                              </Tag>
                            </div>
                            <p
                              className={`mt-1 line-clamp-3 text-[12px] leading-[1.6] ${MUTED}`}
                            >
                              {preset.description || '没有描述'}
                            </p>
                            <div className="mt-auto pt-3">
                              <Button
                                size="small"
                                loading={creatingPresetId === preset.id}
                                onClick={() => void createFromPreset(preset)}
                              >
                                创建画布
                              </Button>
                            </div>
                          </article>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </main>
        ) : (
          <main className="relative min-h-0 flex-1">
            <div className="pointer-events-none absolute left-4 top-[12px] z-10 flex items-center gap-1.5 rounded-[4px] bg-[#FCFCFA]/90 px-2 py-1 text-[11px] text-[#6b6b66] dark:bg-[#17181b]/90 dark:text-[#8b8b85]">
              <span
                className="h-[5px] w-[5px] rounded-full"
                style={{
                  background: config ? (config.mock ? '#B4451F' : '#24543F') : '#b9bcb4',
                }}
              />
              {config ? (config.mock ? 'mock' : 'real') : '连接中'}
            </div>

            {board ? (
              <FlowCanvas
                board={board}
                selectedId={selectedId}
                running={running}
                onSelect={setSelectedId}
                onMove={moveNode}
                onDerive={derive}
                onConnect={connect}
              />
            ) : (
              <div className="grid h-full place-items-center text-[13px] text-[#8a93a3]">
                正在加载画布…
              </div>
            )}
          </main>
        )}

        {view === 'board' && board && selected && (
          <NodePanel
            node={selected}
            nodes={board.nodes}
            edges={board.edges}
            boardId={board.id}
            skills={skills}
            servers={servers}
            catalog={catalog}
            bridge={bridge}
            running={running}
            onPatch={(patch) => patchNode(selected.id, patch)}
            onDerive={(dir) => derive(selected.id, dir)}
            onVerify={(pass) => void confirmVerify(selected.id, pass)}
            onEdgesChange={changeEdges}
            onRefreshModels={() => {
              catalogFetchedAt.current = Date.now();
              void api
                .getModels(true)
                .then(setCatalog)
                .catch((err) => notify(`刷新模型失败：${(err as Error).message}`, 'err'));
              void api.getBridge().then(setBridge).catch(() => {});
            }}
            onRerun={() => void verifyWorkflow([selected.id])}
            onDelete={() => void deleteNode(selected.id)}
            onClose={() => setSelectedId(null)}
          />
        )}

        <SettingsDialog
          open={settingsOpen}
          config={config}
          servers={servers}
          onClose={() => setSettingsOpen(false)}
          onSaved={(cfg) => {
            setConfig((c) => (c ? { ...c, mock: cfg.mock } : c));
            void api.getMcp().then((r) => setServers(r.servers)).catch(() => {});
            notify('设置已保存');
          }}
          onError={(msg) => notify(msg, 'err')}
        />

        <ExportPresetDialog
          open={exportOpen}
          boardId={currentBoardId}
          boardName={boardName}
          onClose={() => setExportOpen(false)}
        />

        <Modal
          open={newOpen}
          title="新建画布"
          centered
          // 内联模式：弹层挂在画布根容器里，才能继承 .dark 与画布 CSS 变量
          getContainer={() => canvasRootRef.current ?? document.body}
          okText="创建"
          cancelText="取消"
          confirmLoading={creating}
          okButtonProps={{ disabled: !newName.trim() }}
          onOk={() => void createBlankBoard()}
          onCancel={() => setNewOpen(false)}
        >
          <Input
            autoFocus
            maxLength={60}
            placeholder="画布名称，例如「活动文案」"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onPressEnter={() => {
              if (newName.trim() && !creating) void createBlankBoard();
            }}
          />
        </Modal>

        {toast && (
          <div
            className={`absolute bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2 text-[13px] shadow-lg ${
              toast.kind === 'err'
                ? 'bg-[#ffebee] text-[#c62828] dark:bg-[#3a1b1f] dark:text-[#ff9a9a]'
                : 'bg-[#1C1C1A] text-white dark:bg-[#e7e9ee] dark:text-[#0f1116]'
            }`}
          >
            {toast.msg}
          </div>
        )}
      </div>
    </ConfigProvider>
  );
}

/** 本地新建节点的 id：时间戳 + 序号，保证同一张画布内唯一 */
function newLocalNodeId(nodes: FlowNode[]): string {
  const base = `n-${Date.now().toString(36)}`;
  let id = base;
  let n = 2;
  while (nodes.some((x) => x.id === id)) id = `${base}-${n++}`;
  return id;
}

/**
 * 画布的对话入口：优先 type==='orchestrator' 的调度（根）节点；
 * 单卡片画布就是那张卡；多卡但没有调度卡 → null（未设置）。
 */
function entryNodeName(board: Board): string | null {
  const picked =
    board.nodes.find((n) => n.type === 'orchestrator') ??
    (board.nodes.length === 1 ? board.nodes[0] : null);
  if (!picked) return null;
  return picked.label || picked.id;
}

/** 画布列表里的更新时间：YYYY-MM-DD HH:mm */
function formatUpdated(ms: number): string {
  if (!ms) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** 判断加 from→to 这条边会不会成环 */
function createsCycle(edges: Edge[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of edges) if (e.from === cur) stack.push(e.to);
  }
  return false;
}
