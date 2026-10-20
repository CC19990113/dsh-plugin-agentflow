/**
 * AgentFlow 画布的内联宿主。
 *
 * 画布从独立页面（iframe）搬进 DSH 的 main slot 后，这个组件负责三件事：
 *   1. 挂载前装好全局桥 `globalThis.__AGENTFLOW_HOST__`，并把主题 / 画布切换
 *      用 `agentflow-theme` / `agentflow-board` 事件推给画布；
 *   2. 把画布与 xyflow 的 CSS 以字符串注入 `<style data-agentflow-style>`，
 *      用 `.af-canvas` 作用域隔离，不污染 DSH 宿主页面；
 *   3. 后端未就绪时先探测 `/api/plugin-alive`（3 次退避、总超时 6s），
 *      失败给错误卡片 + 重试；画布渲染异常由错误边界兜住。
 *
 * 只依赖 React 18 运行时（宿主插件由 DSH 注入 React 18）。
 */

import { Component, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
// 内联模式：CSS 不进产物文件，全部以字符串注入
import canvasCss from '../canvas/index.css?inline';
import xyflowCss from '@xyflow/react/dist/style.css?inline';
import App from '../canvas/App';
import { getApiBase, setApiBase } from './apiBase';
import { readHostTheme, subscribeHostTheme } from './theme';
import type { HostTheme } from './theme';

/** 全局桥的 key：画布侧（src/canvas）按这个约定读取 */
const BRIDGE_KEY = '__AGENTFLOW_HOST__';
/** 注入样式的去重标记：多次挂载/热更新时只留一份 */
const STYLE_ATTR = 'data-agentflow-style';

/** 后端就绪探测：3 次退避，总超时 6s */
const BOOT_RETRY_DELAYS_MS = [0, 1000, 2500];
const BOOT_TIMEOUT_MS = 6000;
const BOOT_PROBE_TIMEOUT_MS = 2000;

interface AgentFlowHostBridge {
  apiBase: string;
  theme: HostTheme;
  boardId: string;
  remote: true;
}

type BridgeGlobal = typeof globalThis & { [BRIDGE_KEY]?: AgentFlowHostBridge };

export interface CanvasHostProps {
  /** 要打开的画布 id；变化时通过 agentflow-board 事件通知画布切换 */
  boardId?: string;
  /** 可选：覆盖后端地址（默认 127.0.0.1:8791，插件配置可传） */
  apiBase?: string;
}

/** 读当前全局桥（可能尚未安装） */
function readBridge(): AgentFlowHostBridge | null {
  try {
    const bridge = (globalThis as BridgeGlobal)[BRIDGE_KEY];
    return bridge && typeof bridge === 'object' ? bridge : null;
  } catch {
    return null;
  }
}

/** 安装全局桥：必须在画布组件首次渲染之前调用 */
function installBridge(next: { apiBase: string; theme: HostTheme; boardId: string }): AgentFlowHostBridge {
  const bridge: AgentFlowHostBridge = {
    apiBase: next.apiBase,
    theme: next.theme,
    boardId: next.boardId,
    remote: true,
  };
  (globalThis as BridgeGlobal)[BRIDGE_KEY] = bridge;
  return bridge;
}

/**
 * 宿主自己的少量样式（加载态 / 错误卡片 / 布局兜底）。
 * 不依赖 Tailwind 扫描，避免宿主文件被 build 的 purge 漏掉。
 */
const HOST_CSS = `
@keyframes af-host-spin { to { transform: rotate(360deg); } }
.af-host, .af-host *, .af-host *::before, .af-host *::after { box-sizing: border-box; }
.af-host-spinner {
  width: 18px; height: 18px; border-radius: 999px;
  border: 2px solid rgba(128, 128, 120, 0.28);
  border-top-color: #24543f;
  animation: af-host-spin 0.8s linear infinite;
}
.af-host-notice {
  max-width: 480px; width: 100%;
  border-radius: 12px; padding: 20px 22px;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB',
    'Microsoft YaHei', ui-sans-serif, sans-serif;
  font-size: 13px; line-height: 1.65;
}
.af-host-notice-title { font-size: 15px; font-weight: 600; }
.af-host-notice-detail { margin-top: 8px; opacity: 0.75; word-break: break-all; }
.af-host-notice-actions { margin-top: 14px; display: flex; align-items: center; gap: 10px; }
.af-host-button {
  border: 1px solid currentColor; border-radius: 7px; padding: 5px 14px;
  font: inherit; font-size: 12.5px; font-weight: 600; color: inherit;
  background: transparent; cursor: pointer;
}
.af-host-button:hover { opacity: 0.75; }
`;

/**
 * 注入画布 + xyflow 样式。返回幂等：已有 `style[data-agentflow-style]` 就跳过。
 *
 * 关键点：Tailwind 的 theme.css 会把主题变量生成在 `:root, :host`（压缩后可能变成
 * `:root,:host`，某些构建配置下也会只剩裸 `:root`）。内联进 DSH 后这些变量会落到
 * 宿主页面上，所以注入前把它们统一收进画布根容器 `.af-canvas`。
 */
function ensureCanvasStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`style[${STYLE_ATTR}]`)) return;
  const scopedCanvasCss = canvasCss.replace(/:root\b(\s*,\s*:host\b)?/g, '.af-canvas');
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  style.textContent = `${xyflowCss}\n${scopedCanvasCss}\n${HOST_CSS}`;
  document.head.appendChild(style);
}

/** 等 ms 毫秒；signal 中途取消时立即返回（由调用方再判断 aborted） */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 探测后端：3 次退避、总超时 6s。true = 已就绪 */
async function probeBackend(signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (let i = 0; i < BOOT_RETRY_DELAYS_MS.length; i += 1) {
    if (signal.aborted) return false;
    const delay = BOOT_RETRY_DELAYS_MS[i];
    if (delay > 0) await wait(delay, signal);
    if (signal.aborted) return false;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;

    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort();
    signal.addEventListener('abort', abortAttempt, { once: true });
    const timer = window.setTimeout(
      () => attempt.abort(),
      Math.min(remaining, BOOT_PROBE_TIMEOUT_MS)
    );
    try {
      const res = await fetch(`${getApiBase()}/api/plugin-alive`, {
        method: 'GET',
        cache: 'no-store',
        signal: attempt.signal,
      });
      if (res.ok) return true;
    } catch {
      /* 后端没起来 / 超时：下一轮重试 */
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', abortAttempt);
    }
  }
  return false;
}

/** 加载态 / 错误卡片：宿主自绘，不依赖 antd，避免画布没起来时连 UI 都没有 */
function HostNotice(props: {
  theme: HostTheme;
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  busy?: boolean;
}): ReactNode {
  const dark = props.theme === 'dark';
  return (
    <div
      className="af-host"
      style={{
        height: '100%',
        minHeight: 160,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: dark ? '#121312' : '#f4f5f2',
        color: dark ? '#e8e8e4' : '#1c1c1a',
      }}
    >
      <div
        className="af-host-notice"
        style={{
          border: `1px solid ${dark ? '#262724' : '#e2e4e0'}`,
          background: dark ? '#17181b' : '#fcfcfa',
        }}
      >
        <div className="af-host-notice-title">{props.title}</div>
        {props.detail ? <div className="af-host-notice-detail">{props.detail}</div> : null}
        <div className="af-host-notice-actions">
          {props.busy ? <span className="af-host-spinner" aria-hidden="true" /> : null}
          {props.onAction && props.actionLabel ? (
            <button type="button" className="af-host-button" onClick={props.onAction}>
              {props.actionLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 画布渲染异常兜底：边界内重试只重置自己，不重跑后端探测 */
class CanvasErrorBoundary extends Component<
  { theme: HostTheme; children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { theme: HostTheme; children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[agentflow] 内联画布渲染失败：', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <HostNotice
          theme={this.props.theme}
          title="画布渲染出错"
          detail={this.state.error.message || String(this.state.error)}
          actionLabel="重试"
          onAction={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

export function CanvasHost({ boardId: boardIdProp, apiBase: apiBaseProp }: CanvasHostProps): ReactNode {
  const boardId = boardIdProp ?? '';

  // 首帧渲染期装好全局桥与样式：画布 App 在子组件里直接读它们。
  // 初始化函数在 StrictMode 下可能跑两次，installBridge / ensureCanvasStyles 都是幂等的。
  const [theme, setTheme] = useState<HostTheme>(() => {
    if (apiBaseProp) setApiBase(apiBaseProp);
    ensureCanvasStyles();
    const initialTheme = readHostTheme();
    installBridge({ apiBase: getApiBase(), theme: initialTheme, boardId });
    return initialTheme;
  });

  // 主题跟宿主：body[data-ds-dark-theme] / html.dark / 系统偏好
  useEffect(() => subscribeHostTheme(setTheme), []);

  // 主题变化：更新全局桥并通知画布（画布把 .dark 挂在自己的根容器上）
  useEffect(() => {
    const bridge = readBridge();
    if (bridge) bridge.theme = theme;
    window.dispatchEvent(
      new CustomEvent<{ theme: HostTheme }>('agentflow-theme', { detail: { theme } })
    );
  }, [theme]);

  // 画布切换：更新全局桥并派发 agentflow-board（画布收到后打开对应画布）
  const lastBoardId = useRef(boardId);
  useEffect(() => {
    const bridge = readBridge();
    if (bridge) bridge.boardId = boardId;
    if (lastBoardId.current === boardId) return;
    lastBoardId.current = boardId;
    window.dispatchEvent(
      new CustomEvent<{ boardId: string }>('agentflow-board', { detail: { boardId } })
    );
  }, [boardId]);

  // apiBase 运行期被上层改掉时同步到全局桥（画布 api.ts 每次请求都会读）
  useEffect(() => {
    if (!apiBaseProp) return;
    const next = setApiBase(apiBaseProp);
    const bridge = readBridge();
    if (bridge) bridge.apiBase = next;
  }, [apiBaseProp]);

  // ---------- 后端就绪探测 ----------
  const [boot, setBoot] = useState<'checking' | 'ready' | 'error'>('checking');
  const [bootAttempt, setBootAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setBoot('checking');
    void probeBackend(controller.signal).then((ready) => {
      if (cancelled) return;
      setBoot(ready ? 'ready' : 'error');
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [bootAttempt]);

  // ---------- 容器高度：父级没高度时退到视口高度 ----------
  const containerRef = useRef<HTMLDivElement>(null);
  const [needsViewportFallback, setNeedsViewportFallback] = useState(false);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let fallbackApplied = needsViewportFallback;
    const measure = () => {
      if (fallbackApplied) return;
      const parent = element.parentElement;
      const parentHeight = parent ? parent.getBoundingClientRect().height : 0;
      const ownHeight = element.getBoundingClientRect().height;
      // height:100% 落不到具体像素（父级没高度）时，用 100vh 兜底，避免画布 0 高
      if (parentHeight < 1 || ownHeight < 1) {
        fallbackApplied = true;
        setNeedsViewportFallback(true);
      }
    };
    measure();
    const frame = window.requestAnimationFrame(measure);
    let observer: ResizeObserver | null = null;
    try {
      observer = new ResizeObserver(measure);
      if (element.parentElement) observer.observe(element.parentElement);
    } catch {
      observer = null;
    }
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(frame);
      if (observer) observer.disconnect();
      window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const baseStyle = {
    position: 'relative',
    width: '100%',
    height: needsViewportFallback ? '100vh' : '100%',
    minHeight: 0,
    overflow: 'hidden',
  } as const;

  return (
    <div
      ref={containerRef}
      className="af-host"
      data-agentflow-host=""
      style={{
        ...baseStyle,
        background: theme === 'dark' ? '#121312' : '#f4f5f2',
        colorScheme: theme === 'dark' ? 'dark' : 'light',
      }}
    >
      {boot === 'checking' ? (
        <HostNotice
          theme={theme}
          title="正在连接 AgentFlow 后端…"
          detail={`等待 ${getApiBase()} 就绪`}
          busy
        />
      ) : boot === 'error' ? (
        <HostNotice
          theme={theme}
          title="连不上 AgentFlow 后端"
          detail={`请确认 ${getApiBase()} 上的 AgentFlow 服务已启动后重试。`}
          actionLabel="重试"
          onAction={() => setBootAttempt((n) => n + 1)}
        />
      ) : (
        <CanvasErrorBoundary theme={theme}>
          <App />
        </CanvasErrorBoundary>
      )}
    </div>
  );
}
