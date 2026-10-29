/**
 * dsh-plugin-agentflow —— 把 AgentFlow（物料画布式 agent 编排器）接进 DSH。
 *
 * 两个工具：
 *   agentflow_list  看画布上有什么：节点、状态、连线、用了哪个模型
 *   agentflow_run   跑画布（或其中几步），把每一步的产出带回来
 *
 * 外加一个本地 llm bridge：AgentFlow server 通过它用 DSH 的 ctx.llm 调模型，
 * 不再自己实现各家 provider 协议（契约见 agent-flow/docs/bridge-contract.md）。
 *
 * 引擎随插件分发：`npm run sync` 把 AgentFlow 源码快照到 runtime/，
 * 安装后不依赖机器上另有 ~/.dsh/agent-flow。开发时仍可用 agentflowDir 或
 * AGENTFLOW_DIR 指回引擎仓库，省得每改一行就重新打包。
 *
 * @module dsh-plugin-agentflow
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { startBridge } from './lib/bridge.js';
import { startObserver } from './lib/observe.js';
import { startCommands, createNodeDoneTool } from './lib/commands.js';

export const name = 'tool-agentflow';

/** 需要宿主的工具注册表、系统提示，以及模型服务（llm bridge 用） */
export const inject = ['tools', 'systemPrompt', 'llm'];

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
/** 随插件分发的引擎快照（npm run sync 生成） */
const BUNDLED_DIR = path.join(PLUGIN_ROOT, 'runtime');
/** 开发机上的引擎仓库 */
const LEGACY_DIR = path.join(os.homedir(), '.dsh', 'agent-flow');
/** 旧引擎自带的单画布数据目录，只在首次启动时抄一次 */
const LEGACY_DATA_DIR = path.join(LEGACY_DIR, 'data');
/** 插件数据目录：不放在安装目录里，升级/重装插件不会丢画布 */
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'agent-flow-data');

/** agentflowDir 配置或 AGENTFLOW_DIR 是否显式指定了引擎目录（开发模式） */
function hasExplicitDir(config) {
  const fromConfig = config && typeof config.agentflowDir === 'string' ? config.agentflowDir : '';
  return Boolean(fromConfig || process.env.AGENTFLOW_DIR);
}

/**
 * 引擎目录：优先插件自带 runtime/；显式配置时指哪用哪；
 * runtime/ 还没生成（开发机没跑 npm run sync）时退回旧目录。
 */
function resolveDir(config) {
  const fromConfig = config && typeof config.agentflowDir === 'string' ? config.agentflowDir : '';
  if (fromConfig) return fromConfig;
  if (process.env.AGENTFLOW_DIR) return process.env.AGENTFLOW_DIR;
  if (existsSync(path.join(BUNDLED_DIR, 'server.mjs'))) return BUNDLED_DIR;
  return LEGACY_DIR;
}

/** 数据目录：插件配置 dataDir > 环境变量 AGENTFLOW_DATA_DIR > ~/.dsh/agent-flow-data */
function resolveDataDir(config) {
  const fromConfig = config && typeof config.dataDir === 'string' ? config.dataDir : '';
  return path.resolve(fromConfig || process.env.AGENTFLOW_DATA_DIR || DEFAULT_DATA_DIR);
}

let dataDirReady = null;
let dataDirReadyKey = '';

/**
 * 数据目录就绪：目录不存在或为空、且旧目录还有 board.json 时，把旧数据抄一份。
 * 每个数据目录只尝试一次；失败只 warn —— 抄不到旧数据也不耽误起服务。
 */
function ensureDataDir(dataDir) {
  if (dataDirReady && dataDirReadyKey === dataDir) return dataDirReady;
  dataDirReadyKey = dataDir;
  dataDirReady = (async () => {
    try {
      const entries = await fs.readdir(dataDir).catch((err) => {
        if (err && err.code === 'ENOENT') return null;
        throw err;
      });
      if (entries && entries.length) return false; // 已有数据，绝不再覆盖
      const sameDir = path.resolve(dataDir) === path.resolve(LEGACY_DATA_DIR);
      const hasLegacy =
        !sameDir && (await fs.access(path.join(LEGACY_DATA_DIR, 'board.json')).then(() => true, () => false));
      if (!hasLegacy) {
        await fs.mkdir(dataDir, { recursive: true });
        return false;
      }
      await fs.mkdir(dataDir, { recursive: true });
      for (const name of await fs.readdir(LEGACY_DATA_DIR)) {
        // bridge 发现文件带进程级 token，抄过来只会让引擎连错地方
        if (name === 'dsh-bridge.json' || name.endsWith('.tmp')) continue;
        await fs.cp(path.join(LEGACY_DATA_DIR, name), path.join(dataDir, name), {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
      }
      console.log('[agentflow] 首次启动：旧数据已从 ' + LEGACY_DATA_DIR + ' 抄到 ' + dataDir);
      return true;
    } catch (err) {
      console.warn('[agentflow] 旧数据迁移失败（已忽略）：' + (err && err.message ? err.message : err));
      return false;
    }
  })();
  return dataDirReady;
}

const DEFAULT_PORT = 8791;

/** config 里的端口可能是字符串，非法值一律回落到默认 8791。 */
function resolvePort(config) {
  const n = Number(config && config.agentflowPort);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

/**
 * 探测本机后端：800ms 内拿到 HTTP 响应就算活着。
 * 超时/连接被拒/任何异常都视为「没活」，交给调用方决定是否拉起。
 */
async function backendAlive(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/', {
      signal: AbortSignal.timeout(800),
    });
    try { await res.body?.cancel(); } catch {}
    return true;
  } catch {
    return false;
  }
}

// 一个 DSH 进程只允许一个自建后端：热重载或重复 apply 都不能叠加子进程。
let backendChild = null;
let backendStarting = false;

function backendRunning() {
  return backendChild !== null && backendChild.exitCode === null && !backendChild.killed;
}

/** 卸载时只杀自己 spawn 的那个；外部已在跑的后端不归插件管。 */
function stopBackend() {
  const child = backendChild;
  backendChild = null;
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill(); } catch {}
  }
}

/**
 * 按需拉起 AgentFlow 后端（fire-and-forget，绝不阻塞 apply、绝不抛错）：
 * 先探测，活着就什么都不做；没活才用当前 Node 起 server.mjs。
 * 失败只 console.warn —— 工具与侧边栏能加载比后端能否起来更重要。
 */
function startBackend(dir, port, dataDir, bridgeDir) {
  if (backendStarting || backendRunning()) return;
  backendStarting = true;
  void (async () => {
    try {
      if (await backendAlive(port)) return;
      if (backendRunning()) return; // 探测期间可能已被别的实例拉起
      await ensureDataDir(dataDir); // 先准备好数据目录（含首次迁移），再起服务
      const child = spawn(process.execPath, ['server.mjs'], {
        cwd: dir,
        detached: false,
        stdio: 'ignore', // 后端日志不能灌进 DSH 终端
        env: {
          ...process.env,
          PORT: String(port),
          // 画布/配置/草稿写到安装目录之外，插件升级或重装不丢数据
          AGENTFLOW_DATA_DIR: dataDir,
          // 引擎默认在自己的 ROOT 下找 dsh-bridge.json；安装后 ROOT 是 runtime/，
          // 必须显式指到插件 bridge 写文件的那个目录
          AGENTFLOW_BRIDGE_DIR: bridgeDir,
        },
      });
      backendChild = child;
      child.unref(); // 不拖住 DSH 的事件循环
      child.on('error', (err) => {
        if (backendChild === child) backendChild = null;
        console.warn('[agentflow] 后端启动失败：' + (err && err.message ? err.message : err));
      });
      child.on('exit', (code) => {
        if (backendChild === child) backendChild = null;
        if (code !== 0 && code !== null) console.warn('[agentflow] 后端退出，code=' + code);
      });
    } catch (err) {
      console.warn('[agentflow] 后端拉起失败（已忽略）：' + (err && err.message ? err.message : err));
    } finally {
      backendStarting = false;
    }
  })();
}

/** 动态加载引擎三件套 */
async function loadEngine(dir) {
  const at = (f) => pathToFileURL(path.join(dir, f)).href;
  const [engine, store, llm] = await Promise.all([
    import(at('engine.mjs')),
    import(at('store.mjs')),
    import(at('llm.mjs')),
  ]);
  return { ...engine, ...store, ...llm };
}

/** 当前画布文件：多画布布局取索引第一张；老的单画布布局退回 board.json */
async function resolveBoardFile(dataDir) {
  try {
    const index = JSON.parse(await fs.readFile(path.join(dataDir, 'boards.json'), 'utf8'));
    const id = Array.isArray(index?.order) ? index.order[0] : null;
    if (id) {
      const file = path.join(dataDir, 'boards', `${id}.json`);
      const exists = await fs.access(file).then(() => true, () => false);
      if (exists) return file;
    }
  } catch {
    /* 没有索引就走旧布局 */
  }
  return path.join(dataDir, 'board.json');
}

async function readBoard(dataDir) {
  const file = await resolveBoardFile(dataDir);
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

/** 原子写回画布：临时文件 + rename，避免半个 JSON 落盘 */
async function writeBoard(dataDir, board) {
  await fs.mkdir(dataDir, { recursive: true });
  const file = await resolveBoardFile(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(board, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** 读引擎配置；没有就按默认值走（normalizeConfig 自己会补） */
async function readConfig(dataDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

const STATUS_ZH = {
  idle: '空闲',
  running: '运行中',
  done: '完成',
  failed: '失败',
  blocked: '阻塞',
  review: '待确认',
};

/** 画布摘要：给人看也够，给模型看也能直接理解 */
function describeBoard(board) {
  const lines = [
    `画布「${board.name || board.id}」：${board.nodes.length} 个节点，${board.edges.length} 条连线`,
    '',
  ];
  for (const n of board.nodes) {
    const ups = board.edges.filter((e) => e.to === n.id).map((e) => e.from);
    const usage = n.usage || {};
    const bits = [
      `- ${n.id}「${n.label}」${STATUS_ZH[n.status] || n.status}`,
      `模型 ${n.model || '未设置'}`,
    ];
    if (ups.length) bits.push(`上游 ${ups.join(',')}`);
    if (n.verify) bits.push(`判断 ${n.verify}`);
    if (n.skills && n.skills.length) bits.push(`技能 ${n.skills.join(',')}`);
    if (n.tools && n.tools.length) bits.push(`工具 ${n.tools.length} 个`);
    if (usage.promptTokens) bits.push(`${usage.promptTokens + (usage.completionTokens || 0)} tok`);
    lines.push(bits.join(' · '));
    if (n.content) {
      const first = String(n.content).split('\n').find((l) => l.trim()) || '';
      lines.push(`    产出：${first.slice(0, 60)}${n.content.length > 60 ? '…' : ''}`);
    }
  }
  return lines.join('\n');
}

export function apply(ctx, config = {}) {
  const dir = resolveDir(config);
  const dataDir = resolveDataDir(config);
  // 开发模式（显式指定引擎目录）：bridge 发现文件仍写在引擎目录里，跟引擎自带 data/ 挨着；
  // 安装模式：引擎是只读快照，bridge 与数据都写到数据目录。
  const bridgeDir = hasExplicitDir(config) ? dir : dataDir;

  // 生命周期：插件加载时按需拉起后端，卸载时把自建子进程收掉。
  // effect 回调本身同步返回；探测与拉起都在后台跑，不阻塞 apply。
  ctx.effect(() => {
    startBackend(dir, resolvePort(config), dataDir, bridgeDir);
    return stopBackend;
  }, 'agentflow: backend');

  // 模型通道：DSH 进程内的 llm bridge。AgentFlow server 通过发现文件找过来，
  // 再用 ctx.llm 调模型；启动失败只 warn，模型通道不可用不影响两个工具加载。
  ctx.effect(() => startBridge(ctx, { dir: bridgeDir }), 'agentflow: bridge');

  // 观察器（阶段 1）：只记每步消息与每次工具调用，不拦不改。
  // 用来在真正做「强制工作流」之前，看清模型实际怎么调工具、在哪收工。
  // `observe: false` 关掉；`observeDir` 换落盘目录。
  if (config.observe !== false) {
    const observeRoot =
      typeof config.observeDir === 'string' && config.observeDir
        ? path.resolve(config.observeDir)
        : path.join(dataDir, 'observe');
    ctx.effect(() => startObserver(ctx, { root: observeRoot }).dispose, 'agentflow: observe');
  }

  // 命令（阶段 2）：引擎侧在 <dataDir>/commands/ 下写命令文件，这里热注册成
  // DSH 的 /agentflow-xxx。宿主没有 commands 服务时 startCommands 内部只 warn，
  // 插件照常加载；`commands: false` 关掉。
  let commandsApi = null;
  if (config.commands !== false) {
    ctx.effect(() => {
      const api = startCommands(ctx, { dir, dataDir });
      commandsApi = api;
      return () => {
        try {
          api.dispose();
        } finally {
          if (commandsApi === api) commandsApi = null;
        }
      };
    }, 'agentflow: commands');
  }

  // ---------- agentflow_node_done ----------
  // 画布工作流的显式完成信号：工具全局注册，只有发起这次 run 的 agent 能调。
  // 没有进行中的 run 时只回一句「当前没有工作流」，不报错。
  ctx.tools.register(
    createNodeDoneTool(
      (agentId) => (commandsApi ? commandsApi.getRun(agentId) : null),
      (agentId, run) => {
        if (commandsApi && typeof commandsApi.persistRun === 'function') commandsApi.persistRun(agentId, run);
      },
    ),
  );

  // ---------- agentflow_list ----------
  ctx.tools.register(
    defineTool({
      name: 'agentflow_list',
      description:
        '列出本机 AgentFlow 画布上的节点：每个节点做了什么任务、什么状态、用了哪个模型、上游是谁、产出了什么。在动手跑之前先用它了解现有编排。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: String(value.text || '') }],
      },
      async execute() {
        try {
          const board = await readBoard(dataDir);
          return { text: describeBoard(board) };
        } catch (err) {
          return {
            text: `读不到画布：${err && err.message ? err.message : err}\n路径：${await resolveBoardFile(dataDir).catch(() => path.join(dataDir, 'board.json'))}`,
          };
        }
      },
      presentCall: () => ({
        card: 'generic',
        title: 'agentflow_list · 看画布',
        kind: 'other',
        rawInput: {},
      }),
    }),
  );

  // ---------- agentflow_run ----------
  ctx.tools.register(
    defineTool({
      name: 'agentflow_run',
      description:
        '执行 AgentFlow 画布（或其中几个节点），返回每一步的产出与状态。节点按上游依赖自动排序：多个上游都完成才开始；某节点所有模型失败只影响自己，它的下游标记阻塞。targets 省略时跑整张图。这会真实调用大模型并产生费用。',
      parameters: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: '只跑这些节点 id（它们的上游会用已有产出）。省略则跑整张图。',
        },
        dry: {
          type: 'boolean',
          description: '只演练调度、不真的调用模型（零成本），用来检查顺序对不对。',
        },
        save: {
          type: 'boolean',
          description: '是否把产出写回画布文件，默认 true。',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: String(value.text || '') }],
      },
      timeoutMs: 600000,
      async execute(args, exec) {
        const targets = Array.isArray(args.targets) && args.targets.length ? args.targets : undefined;
        const save = args.save !== false;
        const dry = args.dry === true;

        let mod;
        try {
          mod = await loadEngine(dir);
        } catch (err) {
          return {
            text: `加载引擎失败：${err && err.message ? err.message : err}\n检查插件 runtime/ 是否已生成（npm run sync），或 agentflowDir 是否指向有效的 AgentFlow 目录`,
          };
        }

        const board = await readBoard(dataDir);
        // 配置也在数据目录里；不走引擎的 loadConfig()，它按引擎 ROOT 冻结了路径
        const cfg = mod.normalizeConfig(await readConfig(dataDir));
        const callLLM = dry
          ? async () => ({ content: '(dry run)', usage: {} })
          : mod.makeCaller({ bridgeDir, mock: cfg.mock, skillDirs: cfg.skillDirs });

        const log = [];
        const t0 = Date.now();
        const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

        const result = await mod.runBoard(board, {
          targets,
          callLLM,
          emit: (ev) => {
            if (ev.type === 'node:start') log.push(`[${stamp()}] ▶ ${ev.id}`);
            else if (ev.type === 'node:done') {
              log.push(`[${stamp()}] ✓ ${ev.id}（${ev.model}）`);
            } else if (ev.type === 'node:retry') {
              log.push(`[${stamp()}] ↻ ${ev.id} ${ev.model} 失败：${ev.error}`);
            } else if (ev.type === 'node:failed') {
              log.push(`[${stamp()}] ✗ ${ev.id} 所有模型失败`);
            } else if (ev.type === 'node:blocked') {
              log.push(`[${stamp()}] ⊘ ${ev.id} 阻塞（${ev.reason}）`);
            }
          },
        });

        // 回写画布：产出、状态、用量
        if (save && !dry) {
          const next = {
            ...board,
            nodes: board.nodes.map((n) => {
              const st = result.state.get(n.id);
              if (!st) return n;
              const out = result.content.get(n.id);
              const model = result.usedModel.get(n.id);
              return {
                ...n,
                status: st,
                ...(out && (st === 'done' || st === 'review') ? { content: out } : {}),
                ...(model ? { usage: { model, ...(result.usage.get(n.id) || {}) } } : {}),
              };
            }),
          };
          await writeBoard(dataDir, next).catch(() => {});
        }

        const { done, failed, blocked, review } = result.summary;
        const sections = [
          `模式：${dry ? 'dry run（未调用模型）' : cfg.mock ? 'mock' : '真实模型'}`,
          `结果：完成 ${done.length} · 失败 ${failed.length} · 阻塞 ${blocked.length}${review?.length ? ` · 待确认 ${review.length}` : ''}`,
          '',
          '执行过程：',
          ...log,
        ];

        // 每个成功节点的产出摘要，方便模型直接判断要不要接着处理
        for (const id of done) {
          const node = board.nodes.find((n) => n.id === id);
          const text = result.content.get(id) || '';
          if (!text) continue;
          sections.push('', `—— ${node ? node.label : id} ——`, text.slice(0, 800) + (text.length > 800 ? '\n…' : ''));
        }

        return { text: sections.join('\n') };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `agentflow_run${Array.isArray(args.targets) && args.targets.length ? ` · ${args.targets.join(',')}` : ' · 全图'}`,
        kind: 'other',
        rawInput: { targets: args.targets, dry: args.dry },
      }),
    }),
  );
}
