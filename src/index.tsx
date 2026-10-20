/**
 * dsh-plugin-agentflow 的浏览器半边。
 *
 * main 槽里渲染画布本体，另有侧边栏入口、设置页分区与插件页菜单三个入口：
 *   slots.register({ name: 'main', key: 'agentflow' }, …)
 *   slots.register({ name: 'sidebar.panellist', id, order, label }, …)
 *   slots.register({ name: 'settings.section', … }, …)
 *   slots.register({ name: 'plugins.add.actions', … }, …)
 *
 * 画布有两种渲染模式（插件配置 agentflowRenderMode）：
 *   native（默认）—— 画布源码编进客户端 bundle，由 src/host/CanvasHost 直接渲染，
 *                    8791 上的 AgentFlow 服务只留 API
 *   iframe        —— 回滚旧行为：iframe 嵌本机跑的 AgentFlow 页面（默认 8791）
 * 旧实现保留在 iframe 模式里，地址可在插件配置里改（agentflowUrl）。
 */

import {
  Component,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { CanvasHost } from './host/CanvasHost.tsx';
import { setApiBase } from './host/apiBase';

/** 侧边栏行与页面共用的 id，命名空间化以免和官方或第三方面板撞车 */
const PANEL_ID = 'agentflow';

/** 左侧栏行序：官方「插件」是 0、「自动化任务」是 10，这里排在它们后面 */
const PANEL_ORDER = 30;

/** 画布渲染方式：native 把画布编进 bundle 直接渲染，iframe 回滚旧行为 */
type RenderMode = 'native' | 'iframe';

/** apply 时从插件配置读入；缺省 native */
let RENDER_MODE: RenderMode = 'native';

function currentRenderMode(): RenderMode {
  return RENDER_MODE;
}

/** 插件配置（客户端 apply 收到的 config） */
interface PluginConfig {
  agentflowUrl?: string;
  agentflowRenderMode?: RenderMode;
}

/** 画布渲染出错时的兜底：错误卡片 + 重试，不把整个插件拖挂 */
class RenderErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportBootError('render', error);
    console.error('[agentflow] 画布渲染失败：', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <RenderErrorCard
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

/** 错误边界里的错误卡片：给原因与一个重试入口 */
function RenderErrorCard({ error, onRetry }: { error: Error; onRetry: () => void }): ReactNode {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...CARD_STYLE, borderColor: 'rgba(180,69,31,0.45)', maxWidth: 640 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#B4451F', marginBottom: 6 }}>
          AgentFlow 画布渲染失败
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.7, opacity: 0.8, wordBreak: 'break-all' }}>
          {error.message || String(error)}
        </div>
        <div style={{ marginTop: 10 }}>
          <SmallButton onClick={onRetry}>重试</SmallButton>
        </div>
      </div>
    </div>
  );
}

function AgentFlowPage(): ReactNode {
  const [boardId, setBoardId] = useState(targetBoardId);
  // 画布会把它有没有未保存修改 postMessage 过来；切回对话时用这个提示
  const dirtyRef = useRef(false);
  useEffect(() => {
    boardListeners.add(setBoardId);
    return () => {
      boardListeners.delete(setBoardId);
    };
  }, []);
  return (
    <RenderErrorBoundary>
      {currentRenderMode() === 'iframe' ? (
        <AgentFlowIframe boardId={boardId} />
      ) : (
        // native 模式下 8791 只提供 API；agentflowUrl 同时作为 API 基地址，保持与 iframe 模式一致
        <CanvasHost boardId={boardId} apiBase={PAGE_URL} />
      )}
    </RenderErrorBoundary>
  );
}

/** iframe 模式：旧实现原样保留，画布地址带 board 与主题参数 */
function AgentFlowIframe({ boardId }: { boardId: string }): ReactNode {
  return (
    <iframe
      src={canvasUrl(boardId)}
      // load / error 都打卡：都不打说明请求被静默拦掉了
      onLoad={() => {
        try {
          fetch('http://127.0.0.1:8791/api/plugin-alive?stage=iframe-load', { mode: 'no-cors' }).catch(() => {});
        } catch {}
      }}
      onError={() => {
        try {
          fetch('http://127.0.0.1:8791/api/plugin-alive?stage=iframe-error', { mode: 'no-cors' }).catch(() => {});
        } catch {}
      }}
      title="AgentFlow"
      // 占满整个主区域；边框去掉，避免和宿主页面之间出现双线
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        display: 'block',
        background: '#f7f8fa',
      }}
    />
  );
}

/** 侧边栏图标：一个画布/节点的抽象图形，跟「自动化任务」的时钟同一视觉体量 */
function AgentFlowIcon({ size }: { size?: number }): ReactNode {
  const s = typeof size === 'number' ? size : 16;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* 左一个方块 + 右两个方块 + 连线，示意「一张卡派生多张」 */}
      <rect x={1.5} y={6} width={4} height={4} rx={1} />
      <rect x={10.5} y={1.5} width={4} height={4} rx={1} />
      <rect x={10.5} y={10.5} width={4} height={4} rx={1} />
      <path d="M5.5 8h2.5V3.5h2.5M8 8v4.5h2.5" />
    </svg>
  );
}

/** 页面地址：构建时写死默认值，运行期可被插件配置覆写 */
let PAGE_URL = 'http://127.0.0.1:8791';

/** apply 时注入；设置页「编辑」优先用它把主视图切到画布，而不是弹浏览器 */
let layoutApi: ClientCtx['layout'] | null = null;

/** 当前要打开的画布 id（设置页点某个预设的「编辑」时设置），native 与 iframe 都用它 */
let targetBoardId = '';
const boardListeners = new Set<(id: string) => void>();

function setTargetBoard(id: string): void {
  targetBoardId = String(id || '');
  for (const fn of boardListeners) {
    try {
      fn(targetBoardId);
    } catch {
      /* 单个订阅失败不影响其它 */
    }
  }
}

/** 读 DSH 当前主题：body[data-ds-dark-theme] → html.dark → 系统偏好 */
function dshTheme(): 'dark' | 'light' {
  try {
    if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return 'dark';
    if (document.documentElement.classList.contains('dark')) return 'dark';
  } catch {
    /* 读不到就往下兜底 */
  }
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch {
    /* 忽略 */
  }
  return 'light';
}

/** 画布地址：带上要打开的画布与 DSH 当前主题（AgentFlow 首次打开时按它初始化） */
function canvasUrl(boardId: string): string {
  const params = new URLSearchParams();
  if (boardId) params.set('board', boardId);
  params.set('theme', dshTheme());
  return `${PAGE_URL}/?${params.toString()}`;
}

/** 能切主视图就切；切不了返回 false，由调用方改走内嵌画布 */
function trySelectPanel(): boolean {
  try {
    if (layoutApi && typeof layoutApi.selectPanel === 'function') {
      layoutApi.selectPanel(PANEL_ID);
      return true;
    }
  } catch {
    /* 拿不到就当没这一手 */
  }
  return false;
}

interface ClientCtx {
  /** Cordis 的同步服务查询；用来在不 inject 的情况下试探 layout 是否就绪 */
  get?: (name: string) => unknown;
  layout?: {
    /** 选中 main 槽里的某个 key；null 回到会话界面 */
    selectPanel?: (id: string | null) => void;
  };
  slots: {
    inject(name: string, factory: () => unknown): void;
    register(spec: Record<string, unknown>, component: unknown): unknown;
  };
  sidebarRightTabs: {
    /** 返回 disposer 函数（文档原文：returning a disposer），不是对象 */
    register(definition: Record<string, unknown>): () => void;
  };
  sidebarRight: {
    openTab(kind: string, options?: Record<string, unknown>): unknown;
  };
}

export const name = 'agentflow';
// layout 是 ui-layout 提供的 root 服务（ctx.reflect.provide("layout", ...)），
// 不 inject 的话访问就会被 cordis 拒绝，只能退回新窗口。
export const inject = ['slots', 'layout'];

/** 上报启动期错误：插件激活失败在 DSH 侧只有一句「failed」，细节得自己捞 */
function reportBootError(where: string, err: unknown): void {
  try {
    const detail = `${where}: ${(err as Error)?.stack || String(err)}`;
    fetch(`${PAGE_URL}/api/plugin-alive?stage=apply-error&detail=${encodeURIComponent(detail.slice(0, 800))}`, {
      mode: 'no-cors',
    }).catch(() => {});
  } catch {
    /* 上报本身失败就算了 */
  }
}

/** 每个插槽都独立兜错：单处注册失败不能影响其它入口，也不能静默消失 */
function registerSlot(
  ctx: ClientCtx,
  where: string,
  slot: string,
  register: () => unknown,
): void {
  try {
    ctx.slots.inject(slot, () => {
      try {
        return register();
      } catch (err) {
        reportBootError(where, err);
        return undefined;
      }
    });
  } catch (err) {
    reportBootError(where, err);
  }
}

export function apply(ctx: ClientCtx, config?: PluginConfig): void {
  try {
    applyInner(ctx, config);
  } catch (err) {
    // 注册环节出错时不要让整个客户端插件不激活：工具和侧边栏还能用
    reportBootError('apply', err);
    console.error('[agentflow] 客户端插件初始化失败：', err);
  }
}

function applyInner(ctx: ClientCtx, config?: PluginConfig): void {
  if (config && typeof config.agentflowUrl === 'string' && config.agentflowUrl) {
    PAGE_URL = config.agentflowUrl;
    // native 模式不经过 iframe，后端地址要在挂载画布前同步给 API 层
    setApiBase(config.agentflowUrl);
  }
  // 缺省 native；只有显式配成 iframe 才走旧实现
  RENDER_MODE = config?.agentflowRenderMode === 'iframe' ? 'iframe' : 'native';

  // 拿 layout 但不写进 inject：inject 一个不存在的服务会让整个客户端插件注入失败。
  // 访问未注入服务的代理器可能直接抛错，所以这里必须 try/catch —— 抛出去整个插件就不激活了。
  // 拿不到就走 openAgentFlow 里的新窗口兜底。
  let maybeLayout: ClientCtx['layout'] | null = null;
  try {
    maybeLayout = ctx.layout ?? null;
  } catch (err) {
    // 正常情况下 inject 了 layout 就不会走到这里；留着是为了别把整个插件拖挂
    reportBootError('layout', err);
    maybeLayout = null;
  }
  layoutApi = maybeLayout;

  // ---- 左侧入口：和 10-19 那版一样，main 与 panellist 用同一个 id ----
  // 页面本体：左侧入口点开后在主区域显示画布
  registerSlot(ctx, 'main', 'main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID }, AgentFlowPage),
  );

  // 设置页「AgentFlow」分区：不离开 DSH 就能把画布导出成预设
  registerSlot(ctx, 'settings.section', 'settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'agentflow',
        order: 90,
        label: () => 'AgentFlow',
        inject: () => ({}),
      },
      AgentFlowSettingsSection,
    ),
  );

  // 插件页「添加插件」菜单：多一个「从 AgentFlow 画布生成预设」
  registerSlot(ctx, 'plugins.add.actions', 'plugins.add.actions', () =>
    ctx.slots.register(
      { name: 'plugins.add.actions', id: 'agentflow-export', inject: () => ({}) },
      ExportPresetMenuItem,
    ),
  );

  // 左侧栏入口行
  registerSlot(ctx, 'sidebar.panellist', 'sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => 'AgentFlow' },
      (props: { size?: number }) => <AgentFlowIcon {...props} />,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 设置页「AgentFlow」分区 + 插件页「添加插件」菜单项                    */
/*                                                                     */
/* 作用：不离开 DSH 就能把当前画布导出成预设（写进 profile 的标记段），   */
/* 导出后提示重启 DSH。数据来自本机 8791 的 /api/board 与               */
/* /api/export/preset，跨源靠 server 的 CORS 白名单放行。               */
/* ------------------------------------------------------------------ */

/** 这两个入口共用的小卡片外观：用半透明边框/底色，深浅主题都能看 */
const CARD_STYLE = {
  border: '1px solid rgba(128,130,120,0.28)',
  borderRadius: 12,
  padding: '14px 16px',
  background: 'rgba(128,130,120,0.06)',
  maxWidth: 560,
} as const;

const BTN_STYLE = {
  border: 'none',
  borderRadius: 8,
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
  background: '#24543F',
  cursor: 'pointer',
} as const;

const BTN_DISABLED = { ...BTN_STYLE, opacity: 0.55, cursor: 'not-allowed' } as const;

interface BoardSummary {
  name?: string;
  nodes?: unknown[];
  edges?: unknown[];
}

interface ExportResult {
  presetId?: string;
  presetName?: string;
  file?: string;
  replaced?: boolean;
  error?: string;
}

function useExportPreset() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    fetch(`${PAGE_URL}/api/export/preset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as ExportResult;
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
      })
      .then((body) => setResult(body))
      .catch((err) => setError(String((err && err.message) || err)))
      .finally(() => setBusy(false));
  };

  return { busy, result, error, run };
}

function useBoardSummary() {
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    setError(null);
    fetch(`${PAGE_URL}/api/board`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as BoardSummary;
      })
      .then(setBoard)
      .catch((err) => setError(String((err && err.message) || err)));
  };

  useEffect(reload, []);
  return { board, error, reload };
}

/** 结果块：成功说明写了哪里、要不要重启；失败直接给原因 */
function ExportFeedback({
  busy,
  result,
  error,
}: {
  busy: boolean;
  result: ExportResult | null;
  error: string | null;
}): ReactNode {
  if (error) {
    return <div style={{ marginTop: 10, fontSize: 12, color: '#B4451F', lineHeight: 1.6 }}>{`导出失败：${error}`}</div>;
  }
  if (busy) {
    return <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>正在写入 profile…</div>;
  }
  if (!result) return null;
  return (
    <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7 }}>
      <div>
        {`已${result.replaced ? '更新' : '写入'}预设 `}
        <b>{result.presetId || ''}</b>
      </div>
      <div style={{ opacity: 0.7, wordBreak: 'break-all' }}>{result.file || ''}</div>
      <div style={{ marginTop: 4, fontWeight: 600 }}>重启 DSH 后生效</div>
    </div>
  );
}

interface PresetItem {
  id: string;
  name: string;
  description: string;
  source: 'profile' | 'bundle';
  packageName: string | null;
  editable: boolean;
  canCopy: boolean;
  order?: number;
}

function usePresets() {
  const [presets, setPresets] = useState<PresetItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = () => {
    setError(null);
    fetch(`${PAGE_URL}/api/presets`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { presets?: PresetItem[]; error?: string };
        if (body.error) throw new Error(body.error);
        setPresets(body.presets || []);
      })
      .catch((err) => setError(String((err && err.message) || err)));
  };

  useEffect(reload, []);

  const copy = (item: PresetItem) => {
    setBusyId(item.id);
    setError(null);
    fetch(`${PAGE_URL}/api/presets/${encodeURIComponent(item.id)}/copy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${item.name} 副本` }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
      })
      .then(() => reload())
      .catch((err) => setError(String((err && err.message) || err)))
      .finally(() => setBusyId(null));
  };

  const remove = (item: PresetItem) => {
    if (!window.confirm(`删除预设「${item.name}」？只删 profile 里的这一行，重启 DSH 生效。`)) return;
    setBusyId(item.id);
    setError(null);
    fetch(`${PAGE_URL}/api/presets/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
      })
      .then(() => reload())
      .catch((err) => setError(String((err && err.message) || err)))
      .finally(() => setBusyId(null));
  };

  return { presets, error, busyId, reload, copy, remove };
}

const CHIP_STYLE = {
  display: 'inline-block',
  padding: '1px 7px',
  borderRadius: 999,
  fontSize: 11,
  border: '1px solid rgba(128,130,120,0.35)',
  opacity: 0.85,
} as const;

function SmallButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        border: `1px solid ${danger ? 'rgba(180,69,31,0.45)' : 'rgba(128,130,120,0.35)'}`,
        borderRadius: 7,
        padding: '4px 10px',
        fontSize: 12,
        background: 'transparent',
        color: danger ? '#B4451F' : 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function AgentFlowSettingsSection({ close }: { close?: () => void }): ReactNode {
  const [canvasOpen, setCanvasOpen] = useState(false);
  const openCanvas = (boardId: string) => {
    // 记住要打开哪张画布：预设 id 就是画布 id
    setTargetBoard(boardId);
    // 宿主渲染 settings.section 时会传 close（关闭设置弹窗那个函数）。
    // 先切主视图，切成功了再关设置，这样就直接看到画布；切不了才内嵌 iframe。
    if (trySelectPanel()) {
      try {
        if (typeof close === 'function') close();
      } catch {
        /* 关不掉就让用户自己关 */
      }
      return;
    }
    setCanvasOpen(true);
  };
  const { board, error: boardError, reload } = useBoardSummary();
  const { busy, result, error, run } = useExportPreset();
  const { presets, error: presetError, busyId, reload: reloadPresets, copy, remove } = usePresets();
  const nodes = board?.nodes?.length ?? 0;
  const edges = board?.edges?.length ?? 0;

  return (
    <div style={CARD_STYLE}>
      {canvasOpen ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              background: '#17181B',
              color: '#EDEDE8',
              fontSize: 13,
            }}
          >
            <span>AgentFlow 画布</span>
            <button
              type="button"
              onClick={() => setCanvasOpen(false)}
              style={{
                border: '1px solid rgba(255,255,255,0.25)',
                borderRadius: 7,
                padding: '4px 12px',
                fontSize: 12,
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              关闭
            </button>
          </div>
          <iframe
            src={canvasUrl(targetBoardId)}
            title="AgentFlow 画布"
            style={{ flex: 1, width: '100%', border: 'none', background: '#F4F5F2' }}
          />
        </div>
      ) : null}
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>AgentFlow 画布 → 预设</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.7, opacity: 0.78 }}>
        {boardError
          ? `读不到画布：${boardError}（确认 AgentFlow 服务在 ${PAGE_URL} 运行）`
          : board
            ? `当前画布「${board.name || '未命名'}」${nodes} 个节点 / ${edges} 条连线`
            : '正在读取画布…'}
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          type="button"
          onClick={run}
          disabled={busy || boardError !== null}
          style={busy || boardError !== null ? BTN_DISABLED : BTN_STYLE}
        >
          {busy ? '导出中…' : '导出当前画布为预设'}
        </button>
        <button
          type="button"
          onClick={reload}
          style={{
            border: '1px solid rgba(128,130,120,0.35)',
            borderRadius: 8,
            padding: '7px 12px',
            fontSize: 12.5,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          刷新画布信息
        </button>
      </div>

      {/* ---- 自定义预设列表：可复制、可删除、可进画布编辑 ---- */}
      <div style={{ marginTop: 16, borderTop: '1px solid rgba(128,130,120,0.25)', paddingTop: 12 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>自定义预设</div>
          <SmallButton onClick={reloadPresets} disabled={busyId !== null}>
            刷新
          </SmallButton>
        </div>
        {presetError ? <div style={{ fontSize: 12, color: '#B4451F' }}>{`读取失败：${presetError}`}</div> : null}
        {!presets ? (
          <div style={{ fontSize: 12, opacity: 0.7 }}>读取中…</div>
        ) : presets.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.7 }}>还没有自定义预设</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {presets.map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 9,
                  background: 'rgba(128,130,120,0.08)',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</div>
                  <div
                    style={{
                      fontSize: 11,
                      opacity: 0.65,
                      display: 'flex',
                      gap: 6,
                      flexWrap: 'wrap',
                      marginTop: 2,
                    }}
                  >
                    <span>{item.id}</span>
                    <span style={CHIP_STYLE}>{item.source === 'profile' ? 'profile' : item.packageName || '插件包'}</span>
                  </div>
                </div>
                <SmallButton onClick={() => copy(item)} disabled={busyId !== null}>
                  {busyId === item.id ? '处理中…' : '复制'}
                </SmallButton>
                {item.editable ? (
                  <SmallButton onClick={() => remove(item)} disabled={busyId !== null} danger>
                    删除
                  </SmallButton>
                ) : null}
                {/* 编辑 = 进 AgentFlow 画布（切主视图；宿主不给就内嵌 iframe） */}
                <SmallButton onClick={() => openCanvas(item.id)}>编辑</SmallButton>
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8, lineHeight: 1.6 }}>
          插件包自带的预设（Sharp Agent / 群友腔）只能复制成自己的再改；删除与编辑只对 profile 里的预设开放。改完记得重启 DSH。
        </div>
      </div>
      <ExportFeedback busy={busy} result={result} error={error} />
    </div>
  );
}

function ExportPresetMenuItem(): ReactNode {
  const { busy, error, run } = useExportPreset();
  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        padding: '8px 12px',
        fontSize: 13,
        cursor: busy ? 'not-allowed' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? '正在导出 AgentFlow 预设…' : '从 AgentFlow 画布生成预设'}
      {error ? (
        <span style={{ display: 'block', fontSize: 11, color: '#B4451F' }}>{error}</span>
      ) : null}
    </button>
  );
}
