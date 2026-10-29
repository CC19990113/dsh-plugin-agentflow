/**
 * lib/client.js 的本地自测（不依赖真实 DSH / 浏览器 / React）。
 *
 * lib/client.js 是 DSH Web 的客户端插件产物，形态固定为
 *   window.__ModuleLoader__.load({ id, factory: (require) => {…} })
 * 本测试用 node:vm 造一个最小浏览器环境：
 *   - window.__ModuleLoader__ 捕获 id 与 factory，并像真加载器一样立即求值
 *   - fake document（querySelector / createElement / head.appendChild）
 *   - fake require（react、react-dom、react-dom/client、react/jsx-runtime、@deepseek-ai/*）
 *   - 迷你 React 运行时（hooks + 极简渲染树），只够跑本插件的组件
 * 然后断言：模块导出、四个插槽、native/iframe 两种渲染模式、agentflowUrl 透传、
 * 重复 apply、样式注入幂等。
 *
 * 注意：本测试依赖构建产物。CI 里必须先 `npm run build` 再跑本测试
 * （见 .github/workflows/publish.yml），否则读到的是过期 bundle。
 *
 * 运行：node test/client.selftest.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_FILE = path.join(ROOT, 'lib', 'client.js');

const PLUGIN_ID = 'dsh-plugin-agentflow';
const DEFAULT_API_BASE = 'http://127.0.0.1:8791';

// ---------------------------------------------------------------------------
// 迷你断言
// ---------------------------------------------------------------------------

const report = { passed: 0, failed: 0 };
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    report.passed += 1;
    console.log(`  ✓ ${name}`);
    return true;
  }
  report.failed += 1;
  failures.push(name + (detail ? ` — ${detail}` : ''));
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function eq(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  return ok(name, pass, pass ? '' : `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
// 假 document：只实现 CanvasHost 构造样式节点需要的那几个方法
// ---------------------------------------------------------------------------

function createFakeDocument() {
  const styles = [];

  const doc = {
    _styles: styles,
    _headChildren: [],
    head: {
      firstChild: null,
      appendChild(node) {
        doc._headChildren.push(node);
      },
      insertBefore() {},
    },
    body: {
      hasAttribute: () => false,
      appendChild() {},
      removeChild() {},
      // antd 的 cssinjs 在模块求值时会扫一遍已有的 style 节点
      querySelectorAll: () => [],
    },
    // 同上：查询已有 style[data-css-hash] 时用
    querySelectorAll: () => [],
    documentElement: {
      classList: { contains: () => false },
      addEventListener() {},
      removeEventListener() {},
    },
    querySelector(selector) {
      // CanvasHost 只查这一种；查到了就说明样式已注入过
      if (selector === 'style[data-agentflow-style]') {
        return styles.find((style) => style.getAttribute('data-agentflow-style') !== null) || null;
      }
      return null;
    },
    createElement(tag) {
      const element = {
        tagName: String(tag).toUpperCase(),
        attributes: {},
        style: {},
        className: '',
        textContent: '',
        setAttribute(name, value) {
          element.attributes[name] = String(value);
        },
        getAttribute(name) {
          return Object.prototype.hasOwnProperty.call(element.attributes, name)
            ? element.attributes[name]
            : null;
        },
        appendChild(child) {
          (element.children ||= []).push(child);
        },
      };
      if (String(tag).toLowerCase() === 'style') styles.push(element);
      return element;
    },
  };

  return doc;
}

// ---------------------------------------------------------------------------
// 迷你 React 运行时：hooks + 渲染成朴素树
//
// 渲染结果：{ tag, props, children } | 文本 | 数组 | null
// 只用于断言组件树，不做 diff / 调度。
// ---------------------------------------------------------------------------

const FRAGMENT = Symbol('Fragment');

function createRenderRuntime() {
  let current = null;
  let states = new WeakMap();
  let dirty = false;
  let flushEffects = false;
  let pendingEffects = [];
  const effectErrors = [];

  function withFrame(key, fn) {
    const previous = current;
    let state = states.get(key);
    if (!state) {
      state = { slots: [] };
      states.set(key, state);
    }
    current = { state, index: 0 };
    try {
      return fn();
    } finally {
      current = previous;
    }
  }

  function nextSlot(create) {
    if (!current) throw new Error('hook 在组件外被调用');
    const index = current.index;
    current.index += 1;
    if (index >= current.state.slots.length) {
      current.state.slots.push({ value: create(), ran: false });
    }
    return current.state.slots[index];
  }

  // ---- hooks ----

  function useState(initial) {
    const slot = nextSlot(() => (typeof initial === 'function' ? initial() : initial));
    const setState = (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next;
      dirty = true;
    };
    return [slot.value, setState];
  }

  function useReducer(reducer, initial, initFn) {
    const slot = nextSlot(() => (typeof initFn === 'function' ? initFn(initial) : initial));
    const dispatch = (action) => {
      slot.value = reducer(slot.value, action);
      dirty = true;
    };
    return [slot.value, dispatch];
  }

  function useRef(initial) {
    return nextSlot(() => ({ current: initial })).value;
  }

  function useEffectImpl(effect) {
    const slot = nextSlot(() => ({ ran: false }));
    if (!flushEffects || slot.ran) return;
    slot.ran = true;
    pendingEffects.push(effect);
  }

  function useMemo(factory) {
    return nextSlot(() => factory()).value;
  }

  function useCallback(callback) {
    return nextSlot(() => callback).value;
  }

  class FakeComponent {
    constructor(props) {
      this.props = props;
    }
    setState(patch) {
      this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch);
      dirty = true;
    }
  }
  class FakePureComponent extends FakeComponent {}
  FakeComponent.prototype.isReactComponent = true;

  const react = {
    Component: FakeComponent,
    PureComponent: FakePureComponent,
    Fragment: FRAGMENT,
    createElement: createElement,
    createContext: (defaultValue) => ({
      _defaultValue: defaultValue,
      Provider: (props) => props.children,
      Consumer: (props) => props.children(defaultValue),
    }),
    forwardRef: (render) => function ForwardRef(props) {
      return render(props, null);
    },
    memo: (component) => component,
    createRef: () => ({ current: null }),
    cloneElement: (element, props) => ({ type: element.type, props: { ...element.props, ...props } }),
    isValidElement: (value) => Boolean(value && typeof value === 'object' && 'type' in value && 'props' in value),
    Children: {
      map: (children, fn) => (Array.isArray(children) ? children : [children]).map(fn),
      toArray: (children) => (Array.isArray(children) ? children : [children]),
      count: (children) => (Array.isArray(children) ? children.length : children == null ? 0 : 1),
      only: (children) => children,
    },
    StrictMode: (props) => props.children,
    Suspense: (props) => props.children,
    useState,
    useReducer,
    useRef,
    useEffect: useEffectImpl,
    useLayoutEffect: useEffectImpl,
    useInsertionEffect: useEffectImpl,
    useMemo,
    useCallback,
    useContext: (context) => (context && '_defaultValue' in context ? context._defaultValue : undefined),
    useId: () => 'id-1',
    useImperativeHandle: () => {},
    useDebugValue: () => {},
    useTransition: () => [false, (fn) => fn()],
    useDeferredValue: (value) => value,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    version: '18.3.1',
  };
  react.default = react;

  function createElement(type, props, ...children) {
    const nextProps = { ...(props || {}) };
    if (children.length === 1) nextProps.children = children[0];
    else if (children.length > 1) nextProps.children = children;
    return { type, props: nextProps };
  }

  function jsx(type, props) {
    return { type, props: props || {} };
  }

  const jsxRuntime = {
    jsx,
    jsxs: jsx,
    jsxDEV: jsx,
    Fragment: FRAGMENT,
  };

  // ---- 渲染 ----

  function renderNode(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map(renderNode).filter((child) => child !== null);
    if (typeof node !== 'object') return null;

    const type = node.type;
    const props = node.props || {};

    if (type === FRAGMENT) return renderNode(props.children);

    if (typeof type === 'function') {
      // class 组件：new 出来再调 render()
      if (type.prototype && type.prototype.isReactComponent) {
        return withFrame(type, () => {
          const instance = new type(props);
          instance.props = props;
          return renderNode(instance.render());
        });
      }
      return withFrame(type, () => renderNode(type(props)));
    }

    if (typeof type === 'string') {
      const rendered = { tag: type, props };
      if (Object.prototype.hasOwnProperty.call(props, 'children')) {
        rendered.children = renderNode(props.children);
      }
      return rendered;
    }

    return null;
  }

  /**
   * 渲染一个根组件。flushEffects=false 时完全不跑 effect（画布会停在
   * 「正在连接…」加载态，不触发 fetch / 不渲染真正的画布 App）。
   */
  async function renderRoot(component, props = {}, options = {}) {
    flushEffects = options.flushEffects === true;
    let tree = null;
    for (let pass = 0; pass < 10; pass += 1) {
      dirty = false;
      pendingEffects = [];
      tree = renderNode({ type: component, props });
      for (const effect of pendingEffects) {
        try {
          effect();
        } catch (error) {
          effectErrors.push(error);
        }
      }
      // 让 effect 里的 fetch Promise 链跑完，再决定要不要重渲染
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!dirty) return tree;
    }
    return tree;
  }

  /** 模拟卸载后重新挂载：清掉所有组件 state（样式去重仍然靠 document） */
  function resetComponentState() {
    states = new WeakMap();
    dirty = false;
    pendingEffects = [];
  }

  return { react, jsxRuntime, renderRoot, resetComponentState, effectErrors, FRAGMENT };
}

// ---------------------------------------------------------------------------
// 渲染树小工具
// ---------------------------------------------------------------------------

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  if (node.children !== undefined) walk(node.children, visit);
}

function findAll(tree, predicate) {
  const hits = [];
  walk(tree, (node) => {
    if (predicate(node)) hits.push(node);
  });
  return hits;
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return textOf(node.children);
  return '';
}

// ---------------------------------------------------------------------------
// 加载 lib/client.js：假 window.__ModuleLoader__ + 假 require
// ---------------------------------------------------------------------------

const TEST_PRESETS = [
  {
    id: 'demo-preset',
    name: '演示预设',
    description: '自测用',
    source: 'profile',
    packageName: null,
    editable: true,
  },
];

let bundleCode = null;

async function loadClient() {
  bundleCode ||= await fs.readFile(CLIENT_FILE, 'utf8');

  const render = createRenderRuntime();
  const document = createFakeDocument();
  const fetchCalls = [];

  const fetchMock = async (input, init) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    let body = {};
    if (url.includes('/api/board')) {
      body = { id: 'demo', name: '测试画布', nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [{ id: 'e1' }] };
    } else if (url.includes('/api/export/command')) {
      body = {
        ok: true,
        name: 'agentflow-demo',
        board: 'demo',
        boardName: '测试画布',
        file: '/tmp/agent-flow-data/commands/agentflow-demo.json',
        replaced: false,
      };
    } else if (url.includes('/api/commands')) {
      body = { commands: [] };
    } else if (url.includes('/api/presets')) {
      body = { presets: TEST_PRESETS };
    }
    return { ok: true, status: 200, json: async () => body };
  };

  const reactDom = { default: {}, createPortal: () => null, flushSync: (fn) => fn() };
  reactDom.default = reactDom;
  const reactDomClient = { createRoot: () => ({ render() {}, unmount() {} }) };
  reactDomClient.default = reactDomClient;

  const requireMock = (id) => {
    switch (id) {
      case 'react':
        return render.react;
      case 'react/jsx-runtime':
      case 'react/jsx-dev-runtime':
        return render.jsxRuntime;
      case 'react-dom':
        return reactDom;
      case 'react-dom/client':
        return reactDomClient;
      default:
        if (id.startsWith('@deepseek-ai/')) return {};
        throw new Error(`自测没有 mock 模块：${id}`);
    }
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URLSearchParams,
    AbortController,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
    fetch: fetchMock,
    process: { env: { NODE_ENV: 'production' } },
    document,
    navigator: { userAgent: 'node-selftest' },
  };

  /** type -> listeners（只给上面那个极简事件总线用） */
  const listeners = new Map();

  vm.createContext(sandbox);
  vm.runInContext('window = globalThis; self = globalThis;', sandbox);
  Object.assign(sandbox, {
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    // 极简事件总线：够跑「画布把当前画布回传给宿主」这条链路
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type);
      if (!list) return;
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event?.type) ?? []) listener(event);
      return true;
    },
    confirm: () => true,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: () => ({ content: '' }),
  });

  const loaded = [];
  sandbox.__ModuleLoader__ = {
    load(entry) {
      const exports = entry.factory(requireMock);
      loaded.push({ id: entry.id, exports });
      return exports;
    },
  };

  vm.runInContext(bundleCode, sandbox, { filename: 'lib/client.js' });

  if (loaded.length !== 1) throw new Error(`__ModuleLoader__.load 被调用 ${loaded.length} 次，期望 1 次`);

  return {
    id: loaded[0].id,
    mod: loaded[0].exports,
    loadCalls: loaded.length,
    document,
    sandbox,
    fetchCalls,
    render,
  };
}

// ---------------------------------------------------------------------------
// 假 ctx：记录 slots.inject / slots.register / layout.selectPanel
// ---------------------------------------------------------------------------

function createCtx(options = {}) {
  const injected = [];
  const registered = [];
  const selected = [];

  let activeSlot = null;
  let mountIndex = 0;

  const ctx = {
    slots: {
      inject(slot, factory) {
        injected.push({ slot, factory });
      },
      register(spec, component) {
        if (options.failRegister) throw new Error('mock slots.register 炸了');
        registered.push({ slot: activeSlot, spec, component });
        return {};
      },
    },
    layout: {
      selectPanel(id) {
        selected.push(id);
      },
    },
  };

  // 模拟宿主：把每个 slots.inject 的 factory 调一次
  function mount() {
    for (; mountIndex < injected.length; mountIndex += 1) {
      const entry = injected[mountIndex];
      activeSlot = entry.slot;
      entry.factory();
    }
    activeSlot = null;
  }

  return { ctx, injected, registered, selected, mount };
}

function byName(registered) {
  const map = new Map();
  for (const item of registered) map.set(item.spec.name, item);
  return map;
}

function slotKey(spec) {
  return `${spec.name}:${spec.key ?? spec.id ?? ''}`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log('client bundle 自测（lib/client.js）\n');

  // =======================================================================
  console.log('加载协议与模块导出');
  // =======================================================================
  const base = await loadClient();
  const mod = base.mod;

  ok('lib/client.js 存在且可求值', typeof mod === 'object' && mod !== null);
  eq('__ModuleLoader__.load 调用次数', base.loadCalls, 1);
  eq('加载 id', base.id, PLUGIN_ID);
  ok('没有全局 require（factory 注入）', vm.runInContext('typeof require', base.sandbox) === 'undefined');
  eq('name', mod.name, 'agentflow');
  eq('inject', mod.inject, ['slots', 'layout']);
  eq('apply 是函数', typeof mod.apply, 'function');
  eq('没有多余的导出', Object.keys(mod).sort(), ['apply', 'inject', 'name']);

  // =======================================================================
  console.log('\n插槽注册（apply）');
  // =======================================================================
  {
    const { ctx, injected, registered, mount } = createCtx();
    let threw = null;
    try {
      mod.apply(ctx);
    } catch (error) {
      threw = error;
    }
    ok('apply 不抛异常', threw === null, threw && String(threw));
    eq('slots.inject 覆盖四个插槽', [...new Set(injected.map((item) => item.slot))].sort(), [
      'main',
      'plugins.add.actions',
      'settings.section',
      'sidebar.panellist',
    ]);
    eq('每个插槽只 inject 一次', injected.length, 4);

    mount();
    eq('宿主挂载后注册四条', registered.length, 4);

    const map = byName(registered);
    ok('注册了 main', map.has('main'));
    ok('注册了 sidebar.panellist', map.has('sidebar.panellist'));
    ok('注册了 settings.section', map.has('settings.section'));
    ok('注册了 plugins.add.actions', map.has('plugins.add.actions'));

    const mainSlot = map.get('main');
    eq('main 的 key', mainSlot.spec.key, 'agentflow');
    eq('main 的组件是函数', typeof mainSlot.component, 'function');

    const sidebar = map.get('sidebar.panellist');
    eq('sidebar 的 id', sidebar.spec.id, 'agentflow');
    eq('sidebar 的 order', sidebar.spec.order, 30);
    eq('sidebar 的 label', sidebar.spec.label(), 'AgentFlow');
    eq('sidebar 的组件是函数', typeof sidebar.component, 'function');

    const settings = map.get('settings.section');
    eq('settings 的 id', settings.spec.id, 'agentflow');
    eq('settings 的 order', settings.spec.order, 90);
    eq('settings 的 label', settings.spec.label(), 'AgentFlow');
    eq('settings 的 inject', typeof settings.spec.inject, 'function');

    const pluginMenu = map.get('plugins.add.actions');
    eq('plugins.add.actions 的 id', pluginMenu.spec.id, 'agentflow-export');
    eq('plugins.add.actions 的组件是函数', typeof pluginMenu.component, 'function');

    // 侧边栏图标：渲染出来应该是一个 svg
    const iconTree = await base.render.renderRoot(sidebar.component, { size: 16 });
    eq('侧边栏图标渲染为 svg', findAll(iconTree, (node) => node.tag === 'svg').length, 1);

    // ---- native 默认：主视图渲染宿主画布，不开 iframe ----
    const pageTree = await base.render.renderRoot(mainSlot.component, {});
    eq('native 默认不创建 iframe', findAll(pageTree, (node) => node.tag === 'iframe').length, 0);

    const hosts = findAll(
      pageTree,
      (node) => node.tag === 'div' && Object.prototype.hasOwnProperty.call(node.props, 'data-agentflow-host')
    );
    eq('native 渲染 CanvasHost 宿主节点', hosts.length, 1);
    eq('宿主节点类名 af-host', hosts[0] && hosts[0].props.className, 'af-host');
    ok('native 首帧是宿主加载态', textOf(pageTree).includes('正在连接 AgentFlow 后端'));

    const bridge = base.sandbox.__AGENTFLOW_HOST__;
    ok('装了全局桥 __AGENTFLOW_HOST__', Boolean(bridge));
    eq('桥的 apiBase 默认 8791', bridge && bridge.apiBase, DEFAULT_API_BASE);
    eq('桥的 theme', bridge && bridge.theme, 'light');
    eq('桥的 boardId 缺省为空', bridge && bridge.boardId, '');
    eq('桥标记 remote', bridge && bridge.remote, true);

    eq('native 渲染不触发后端请求/错误上报', base.fetchCalls.length, 0);

    // ---- 样式注入：一次；再挂载一次仍然是一份 ----
    eq('注入一份 style[data-agentflow-style]', base.document._styles.length, 1);
    const style = base.document._styles[0];
    eq('style 带 data-agentflow-style 属性', style && style.getAttribute('data-agentflow-style'), '');
    ok('画布样式被注入', style && style.textContent.includes('.af-canvas'));
    ok('宿主样式被注入', style && style.textContent.includes('.af-host-spinner'));
    ok('样式经 head 挂载', base.document._headChildren.includes(style));

    base.render.resetComponentState(); // 模拟卸载再挂载
    await base.render.renderRoot(mainSlot.component, {});
    eq('重复挂载样式仍然只有一份（幂等）', base.document._styles.length, 1);
    ok('重复挂载后全局桥仍在', Boolean(base.sandbox.__AGENTFLOW_HOST__));

    // ---- 插件页菜单项：生成命令 ----
    base.render.resetComponentState();
    let menuTree = await base.render.renderRoot(pluginMenu.component, {}, { flushEffects: true });
    ok(
      '菜单项文案是「从 AgentFlow 画布生成命令」',
      textOf(menuTree).includes('从 AgentFlow 画布生成命令'),
      textOf(menuTree)
    );
    // 内联画布回传当前画布后，生成命令必须带 board=，不能再盲目用索引第一张
    base.sandbox.dispatchEvent({ type: 'agentflow-board-active', detail: { boardId: 'board-from-canvas' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    menuTree = await base.render.renderRoot(pluginMenu.component, {}, { flushEffects: true }); // 让 state 更新后的树参与断言

    const menuButton = findAll(menuTree, (node) => node.tag === 'button')[0];
    ok('菜单项渲染成 button', Boolean(menuButton));
    if (menuButton) menuButton.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const menuAfter = textOf(await base.render.renderRoot(pluginMenu.component, {}));
    ok('菜单项展示生成的命令名', menuAfter.includes('/agentflow-demo'), menuAfter);
    ok('菜单项提示无需重启', menuAfter.includes('无需重启'), menuAfter);
    ok(
      '菜单项 POST 到 /api/export/command 且带上当前画布',
      base.fetchCalls.some(
        (call) =>
          call.url.includes('/api/export/command') &&
          call.url.includes('board=board-from-canvas') &&
          call.init &&
          call.init.method === 'POST'
      ),
      JSON.stringify(base.fetchCalls.map((call) => call.url).slice(-3))
    );

    eq('自测期间的 effect 都没有抛错', base.render.effectErrors.length, 0);
  }

  // =======================================================================
  console.log('\nagentflowUrl 透传到 API base');
  // =======================================================================
  {
    const client = await loadClient();
    const customUrl = 'http://127.0.0.1:18791';
    const { ctx, registered, mount } = createCtx();
    client.mod.apply(ctx, { agentflowUrl: customUrl });
    mount();

    const mainSlot = byName(registered).get('main');
    const tree = await client.render.renderRoot(mainSlot.component, {});
    eq('显式配置后仍是 native（不开 iframe）', findAll(tree, (node) => node.tag === 'iframe').length, 0);
    eq('agentflowUrl 写进全局桥的 apiBase', client.sandbox.__AGENTFLOW_HOST__.apiBase, customUrl);
    ok('宿主加载态显示自定义地址', textOf(tree).includes(customUrl));
  }

  // =======================================================================
  console.log('\n设置页：画布 → 命令 / 旧预设清理');
  // =======================================================================
  {
    const client = await loadClient();
    const { ctx, registered, mount } = createCtx();
    client.mod.apply(ctx);
    mount();

    const settingsComponent = byName(registered).get('settings.section').component;
    const settingsTree = await client.render.renderRoot(settingsComponent, {}, { flushEffects: true });
    const settingsText = textOf(settingsTree);
    ok('设置页渲染出「画布 → 命令」标题', settingsText.includes('AgentFlow 画布 → 命令'), settingsText);
    ok('设置页有旧预设清理区', settingsText.includes('旧预设清理'), settingsText);
    ok('设置页说明预设生成已下线', settingsText.includes('预设生成已下线'), settingsText);

    const buttonTexts = findAll(settingsTree, (node) => node.tag === 'button').map((node) => textOf(node));
    ok('设置页有生成命令按钮', buttonTexts.includes('生成当前画布命令'), buttonTexts.join('|'));
    ok('历史预设条目给出删除按钮', buttonTexts.includes('删除'), buttonTexts.join('|'));
    ok('设置页不再有复制按钮', !buttonTexts.includes('复制'), buttonTexts.join('|'));
    ok('设置页不再有编辑按钮', !buttonTexts.includes('编辑'), buttonTexts.join('|'));

    const openButton = findAll(
      settingsTree,
      (node) => node.tag === 'button' && textOf(node) === '打开画布'
    )[0];
    ok('设置页有「打开画布」按钮', Boolean(openButton));
    eq('有画布 id 时「打开画布」可点', Boolean(openButton && !openButton.props.disabled), true);

    const deleteButton = findAll(settingsTree, (node) => node.tag === 'button' && textOf(node) === '删除')[0];
    ok('历史预设条目渲染出删除按钮', Boolean(deleteButton));
    if (deleteButton) deleteButton.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    ok(
      '删除历史预设走 DELETE /api/presets/<id>',
      client.fetchCalls.some(
        (call) => call.url.endsWith('/api/presets/demo-preset') && call.init && call.init.method === 'DELETE'
      )
    );

    const genButton = findAll(
      settingsTree,
      (node) => node.tag === 'button' && textOf(node) === '生成当前画布命令'
    )[0];
    ok('生成命令按钮可点', Boolean(genButton));
    if (genButton) genButton.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterGen = textOf(await client.render.renderRoot(settingsComponent, {}));
    ok('设置页展示生成的命令名', afterGen.includes('/agentflow-demo'), afterGen);
    ok('设置页提示无需重启', afterGen.includes('无需重启'), afterGen);
    ok(
      '设置页 POST 到 /api/export/command',
      client.fetchCalls.some(
        (call) => call.url.endsWith('/api/export/command') && call.init && call.init.method === 'POST'
      )
    );
  }

  // =======================================================================
  console.log("\nagentflowRenderMode: 'iframe' 回滚模式");
  // =======================================================================
  {
    const client = await loadClient();
    const iframeBase = 'http://127.0.0.1:9999';
    const { ctx, registered, mount } = createCtx();
    client.mod.apply(ctx, { agentflowRenderMode: 'iframe', agentflowUrl: iframeBase });
    mount();

    const map = byName(registered);
    client.render.resetComponentState(); // 模拟重新挂载主视图
    const pageTree = await client.render.renderRoot(map.get('main').component, {});
    const iframes = findAll(pageTree, (node) => node.tag === 'iframe');
    eq('iframe 模式创建 iframe', iframes.length, 1);
    const src = (iframes[0] && iframes[0].props.src) || '';
    eq('iframe src 指向配置的地址', src.startsWith(`${iframeBase}/?`), true);
    eq('iframe src 不再默认带 board 参数', src.includes('board='), false);
    ok('iframe src 带 theme 参数', src.includes('theme=light'));
    eq(
      'iframe 模式不渲染 CanvasHost 宿主节点',
      findAll(pageTree, (node) => Object.prototype.hasOwnProperty.call(node.props, 'data-agentflow-host')).length,
      0
    );
    eq('iframe 模式不注入画布样式', client.document._styles.length, 0);
  }

  // =======================================================================
  console.log('\n重复 apply 与单插槽失败的隔离');
  // =======================================================================
  {
    const client = await loadClient();
    const first = createCtx();
    const second = createCtx();

    let threw = null;
    try {
      client.mod.apply(first.ctx);
      client.mod.apply(second.ctx);
    } catch (error) {
      threw = error;
    }
    ok('连续 apply 两次不抛异常', threw === null, threw && String(threw));

    first.mount();
    second.mount();
    eq('两次 apply 各注册 4 条', [first.registered.length, second.registered.length], [4, 4]);

    const keysFirst = first.registered.map((item) => slotKey(item.spec));
    const keysSecond = second.registered.map((item) => slotKey(item.spec));
    eq('同一次 apply 内没有重复 key', new Set(keysFirst).size, keysFirst.length);
    eq('两次 apply 注册的 key 集合一致', new Set([...keysFirst, ...keysSecond]).size, 4);
    eq('重复 apply 不产生新 key', [...new Set([...keysFirst, ...keysSecond])].sort(), [
      'main:agentflow',
      'plugins.add.actions:agentflow-export',
      'settings.section:agentflow',
      'sidebar.panellist:agentflow',
    ]);

    // slots.inject 抛错时其它插槽仍要注册，且 apply 整体不抛
    const failing = createCtx();
    failing.ctx.slots.inject = (slot) => {
      if (slot === 'main') throw new Error('mock inject 炸了');
      failing.injected.push({ slot, factory: () => {} });
    };
    let failedApplyThrew = null;
    try {
      client.mod.apply(failing.ctx);
    } catch (error) {
      failedApplyThrew = error;
    }
    ok('单个 slots.inject 抛错不影响 apply', failedApplyThrew === null);
    eq('其余三个插槽仍然注册', failing.injected.map((item) => item.slot), [
      'settings.section',
      'plugins.add.actions',
      'sidebar.panellist',
    ]);

    // slots.register 抛错时，宿主拿到 undefined 而不是异常
    const broken = createCtx({ failRegister: true });
    client.mod.apply(broken.ctx);
    let mountThrew = null;
    let factoriesReturned = [];
    try {
      for (const item of broken.injected) factoriesReturned.push(item.factory());
    } catch (error) {
      mountThrew = error;
    }
    ok('slots.register 抛错时 factory 不把异常抛给宿主', mountThrew === null, mountThrew && String(mountThrew));
    eq('失败的注册回退为 undefined', factoriesReturned, [undefined, undefined, undefined, undefined]);
    ok(
      '失败路径上报了 apply-error',
      client.fetchCalls.some((call) => call.url.includes('/api/plugin-alive?stage=apply-error'))
    );
  }

  // =======================================================================
  console.log('\n──────────────────────────────');
  console.log(`结果：通过 ${report.passed} · 失败 ${report.failed}`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const failure of failures) console.log('  - ' + failure);
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
}

main().catch((err) => {
  console.error('测试脚本自身异常：', err);
  process.exitCode = 1;
});
