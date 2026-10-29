/**
 * 命令热注册：把 AgentFlow 画布变成 DSH 里的 /agentflow-xxx 命令。
 *
 * 引擎侧（AgentFlow web 的「生成命令」）只写一个契约文件：
 *   <dataDir>/commands/<name>.json = {version:1, name, board, createdAt}
 * 插件这边不 import 引擎代码，直接读命令目录 + 画布文件，所以：
 *   - 引擎随时可写、可删；插件 10s 轮询 + fs.watch（200ms debounce）全量 diff，
 *     新增注册、消失注销、描述/画布变化重注册 —— 用户不用重启 DSH。
 *   - runtime/commands.mjs 还没生成时也能跑：这里不依赖它。
 *
 * 命令行为（全部直接由命令 registry 执行，不经过模型调度）：
 *   /agentflow-x            只看画布：画布名 + 每个节点的 id/label/task/上游 + 用法
 *   /agentflow-x 要做的事    按画布 DAG 开一个 run：根节点先干，agentflow_node_done 推动分层派发
 *   /agentflow-x off        退出该画布工作流
 *
 * run 的推进由四个钩子接力（和命令同一个 ctx.inject 作用域）：
 *   agent/pre-step       每步追加当前层提示（先 next()，reject 原样返回）
 *   agent/turn-stopping  该派发就催 spawn_teammate；请求过但没 spawn 成功就超时催办；
 *                        根节点没完成就催 node_done；完成后不再 steer
 *   tools/pre-execute    只放行本 run 已请求/已 spawn 的 teammate 名（名字必须走 spawnNameFor）
 *   tools/post-execute   观察到成功的 spawn_teammate 才 markSpawned —— dispatched 的唯一真实来源
 *
 * 纪律：画布/命令文件坏了只 warn 跳过；命令 handler 与钩子绝不 throw 到宿主 ——
 * 命令是会话入口，坏了不能连累当前对话。同一 agent 同时只允许一个 active run。
 *
 * @module lib/commands
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  createRun,
  isActive,
  markDone,
  toDispatch,
  markRequested,
  markSpawned,
  awaitingSpawn,
  spawnNameFor,
  nodeForSpawnName,
  regenerateSpawnName,
  startInstruction,
  dispatchInstruction,
  summaryInstruction,
  stepHint,
  hintSignature,
  serializeRun,
  deserializeRun,
  statusLine,
  FLOW_STATES,
} from './flow.js';

/** 原子写 JSON：先写 .tmp 再 rename，避免重启读到半个文件。 */
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

/** 已请求派发但没看到 spawn 成功时的重试间隔：不要每步都催。 */
const SPAWN_RETRY_MS = 120_000;

/** DSH 命令名约束：小写字母开头，只含小写字母/数字/下划线/连字符，<=48 字符（与引擎对齐）。 */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;
const COMMAND_NAME_MAX = 48;
/** 轮询兜底间隔：fs.watch 在某些文件系统（网络盘/容器挂载）上会漏事件。 */
const DEFAULT_POLL_MS = 10_000;
/** fs.watch 防抖：一次保存往往连着好几个事件。 */
const DEFAULT_DEBOUNCE_MS = 200;
/** steer 进对话的文本总长上限：画布再大也不许把上下文灌爆。 */
const MAX_TEXT = 4000;
/** 命令输入提示（客户端输入框里的 placeholder）。 */
const INPUT_HINT = '[off|要做的事] 默认只看画布';

// ---------------------------------------------------------------------------
// 纯函数：容错读取 + 摘要 + 截断（全部可单测，不碰 fs）
// ---------------------------------------------------------------------------

function asString(value) {
  return typeof value === 'string' ? value : '';
}

/** 命令名是否满足 DSH 的注册约束（正则 + 长度 <= 48，和引擎的 normalizeCommandName 对齐）。 */
export function isCommandName(name) {
  return typeof name === 'string' && name.length <= COMMAND_NAME_MAX && COMMAND_NAME.test(name);
}

/**
 * 截断到 limit 个字符（含省略号），保证返回值长度 <= limit。
 * 非字符串一律先压成字符串；非法 limit 回落到 MAX_TEXT。
 */
export function clipText(value, limit = MAX_TEXT) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_TEXT;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 容错解析一个命令文件。
 * 契约之外的字段忽略；name 缺失时用文件名兜底；名字非法或没有 board 返回 null。
 *
 * @param {unknown} raw 命令文件 JSON
 * @param {string} [fallbackName] 文件名（去掉 .json）
 * @returns {{version:number,name:string,board:string,createdAt:number}|null}
 */
export function normalizeCommandRecord(raw, fallbackName = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = asString(raw.name) || asString(fallbackName);
  const board = asString(raw.board);
  if (!isCommandName(name) || !board) return null;
  const version = Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1;
  const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0;
  return { version, name, board, createdAt };
}

/**
 * 容错归一化一张画布：节点按 id/label/task/criteria/model/upstream 读，
 * 上游优先用节点自带的 upstream，没有就按 edges 反推（引擎真实数据就是 edges）。
 *
 * @param {unknown} raw 画布文件 JSON
 * @param {string} [fallbackId] 文件对应的画布 id
 * @returns {{id:string,name:string,nodes:Array<object>,edges:Array<object>}}
 */
export function normalizeBoard(raw, fallbackId = '') {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = asString(source.id) || asString(fallbackId);
  const name = asString(source.name) || id || '(未命名画布)';

  const edges = (Array.isArray(source.edges) ? source.edges : [])
    .map((edge) => {
      if (!edge || typeof edge !== 'object') return null;
      const from = asString(edge.from);
      const to = asString(edge.to);
      return from && to ? { from, to } : null;
    })
    .filter(Boolean);

  const incoming = new Map();
  for (const edge of edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge.from);
    incoming.set(edge.to, list);
  }

  const nodes = (Array.isArray(source.nodes) ? source.nodes : []).map((node, index) => {
    const value = node && typeof node === 'object' ? node : {};
    const nodeId = asString(value.id) || `n${index + 1}`;
    const declared = Array.isArray(value.upstream) ? value.upstream.map(asString).filter(Boolean) : [];
    return {
      id: nodeId,
      label: asString(value.label) || nodeId,
      // 引擎的权威标记：调度卡 type === 'orchestrator'（旧画布没有这个字段）
      type: asString(value.type),
      // 引擎里任务正文就叫 task；instruction/prompt 只是给别的导出格式留的容错
      task: asString(value.task) || asString(value.instruction) || asString(value.prompt),
      // criteria 只认 criteria：verify 是 self/jev 模式的判定值，不是验收标准
      criteria: asString(value.criteria),
      model: asString(value.model),
      provider: asString(value.provider),
      reasoningEffort: asString(value.reasoningEffort),
      skills: Array.isArray(value.skills) ? value.skills.map(asString).filter(Boolean) : [],
      tools: Array.isArray(value.tools) ? value.tools.map(asString).filter(Boolean) : [],
      // MCP 节点：确定性执行单个工具，没有 task 正文
      tool: asString(value.tool),
      args: value.args && typeof value.args === 'object' ? value.args : undefined,
      upstream: declared.length ? declared : (incoming.get(nodeId) ?? []),
    };
  });

  return { id, name, nodes, edges };
}

/** 单行节点摘要：id/label/任务/上游/模型。 */
export function describeNode(node) {
  const task = String(node?.task ?? '').replace(/\s+/g, ' ').trim();
  const upstream = Array.isArray(node?.upstream) && node.upstream.length ? node.upstream.join(',') : '无';
  const bits = [`- ${node?.id ?? '?'}「${node?.label ?? '?'}」`];
  if (task) bits.push(`任务：${clipText(task, 80)}`);
  bits.push(`上游：${upstream}`);
  if (node?.model) bits.push(`模型：${node.model}`);
  return bits.join(' · ');
}

/** 画布摘要：第一行画布名与节点数，之后每个节点一行。 */
export function buildBoardSummary(board) {
  const safe = normalizeBoard(board);
  const lines = [`画布「${safe.name}」· ${safe.nodes.length} 个节点`];
  if (!safe.nodes.length) lines.push('（画布还没有节点）');
  for (const node of safe.nodes) lines.push(describeNode(node));
  return lines.join('\n');
}

/**
 * 无输入时返回给 UI 的文本：画布 + 节点列表 + 用法。
 * 只读本地文件，不 steer、不烧 token。
 *
 * @param {string} commandName 命令名（不带 /）
 * @param {object} board 画布
 * @param {number} [limit] 文本上限
 */
export function buildCanvasText(commandName, board, limit = MAX_TEXT) {
  const usage = [
    '用法：',
    `  /${commandName} <要做的事>   进入工作流，把画布与你的要求一起交给模型`,
    `  /${commandName}              只看画布（不唤醒模型）`,
    `  /${commandName} off          退出「${normalizeBoard(board).name}」工作流`,
  ];
  return clipText([buildBoardSummary(board), '', ...usage].join('\n'), limit);
}

// ---------------------------------------------------------------------------
// 热注册
// ---------------------------------------------------------------------------

function warn(message) {
  console.warn('[agentflow] 命令：' + message);
}

function errorText(err) {
  return err && err.message ? err.message : String(err);
}

/** agent 身份：本体 id 就是 session id；缺失时归到同一桶，别让 Map 炸。 */
function agentKey(agent) {
  return agent && agent.id !== undefined && agent.id !== null ? String(agent.id) : 'unknown';
}

function inert() {
  return {
    dispose() {},
    reload: async () => {},
    ready: Promise.resolve(),
    registered: new Map(),
    modes: new Map(),
    getRun: () => null,
  };
}

/**
 * 一次「命令目录 → 已注册命令」的会话。
 * 服务可用后 attach；dispose 时停 watcher/定时器并注销全部命令。
 */
class CommandSession {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.engineDir = options.dir || '';
    this.commandsDir = path.join(options.dataDir, 'commands');
    /** 进行中的 run 落盘目录：DSH 重启后还能续跑 */
    this.runsDir = path.join(options.dataDir, 'runs');
    this.pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : DEFAULT_POLL_MS;
    this.debounceMs =
      Number.isFinite(options.debounceMs) && options.debounceMs >= 0 ? options.debounceMs : DEFAULT_DEBOUNCE_MS;

    this.commands = null;
    /** name -> {dispose, signature, description, boardId} */
    this.registered = new Map();
    /** agentId -> run（或历史遗留的 boardId 字符串，只当"记过画布"）*/
    this.modes = new Map();
    /** agentId -> 已发起过的 run 次数：Agent Teams 的 roster 名字不复用，第 N 次要带 -rN 后缀 */
    this.runCounts = new Map();
    /** 可选的 Agent Teams 服务：/off 时顺手中断已派出去的 teammate */
    this.agentTeams = null;
    /** 四个 agent/tools 钩子的 disposer（和 commands 同一 inject 作用域）*/
    this.hookDisposers = [];

    this.started = false;
    this.disposed = false;
    this.ready = null;
    this.chain = Promise.resolve();
    this.watcher = null;
    this.pollTimer = null;
    this.debounceTimer = null;
    /** 同一类坏文件只 warn 一次，避免 10s 轮询刷屏 */
    this.warned = new Set();
  }

  /**
   * 中止 run 时把已经派出去的 teammate 也打断，避免它们继续烧 token。
   * 服务不可用/目标已不在时只 warn，不影响退出。
   * @returns {number} 成功中断的数量
   */
  interruptSpawned(agent, run) {
    const teams = this.agentTeams;
    if (!teams || typeof teams.interrupt !== 'function' || !run) return 0;
    let stopped = 0;
    for (const nodeId of run.spawned) {
      const name = spawnNameFor(run, nodeId);
      try {
        teams.interrupt(agent, name);
        stopped += 1;
      } catch (err) {
        warn(`中断 teammate ${name} 失败（已忽略）：` + errorText(err));
      }
    }
    return stopped;
  }

  /** 落盘 / 清理进行中的 run（fire-and-forget，失败只 warn）。 */
  persistRun(agentKey, run) {
    const key = String(agentKey || '');
    if (!key) return;
    const file = path.join(this.runsDir, `${key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)}.json`);
    const data = run && !run.finishedAt && !run.stuck ? serializeRun(run) : null;
    const task = data
      ? fsp
          .mkdir(this.runsDir, { recursive: true })
          .then(() => writeJsonAtomic(file, data))
          .catch((err) => warn('保存工作流状态失败（已忽略）：' + errorText(err)))
      : fsp.rm(file, { force: true }).catch(() => {});
    void task;
  }

  /**
   * 启动时恢复上次没跑完的 run。
   *
   * 恢复的 run 会换新 token 并清空 spawned/requested：重启后旧 teammate 已经没了，
   * roster 却还记得旧名字，不清就会既派不出去也等不到回报。
   */
  async loadPersistedRuns() {
    let files;
    try {
      files = await fsp.readdir(this.runsDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      warn('读工作流状态目录失败（已忽略）：' + errorText(err));
      return;
    }
    let restored = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(this.runsDir, file);
      try {
        const raw = JSON.parse(await fsp.readFile(full, 'utf8'));
        const run = deserializeRun(raw);
        const agentKey = file.slice(0, -'.json'.length);
        if (!run || run.finishedAt || run.stuck) {
          await fsp.rm(full, { force: true });
          continue;
        }
        // 已经在本进程里活跃的 run（例如刚建的）不覆盖
        if (this.activeRun({ id: agentKey })) continue;
        run.ownerId = run.ownerId || agentKey;
        this.modes.set(agentKey, run);
        restored += 1;
      } catch (err) {
        warn(`工作流状态损坏，已跳过 ${file}：` + errorText(err));
        await fsp.rm(full, { force: true }).catch(() => {});
      }
    }
    if (restored > 0) {
      warn(`已恢复 ${restored} 个未完成的工作流（重启后旧 teammate 已不在，会重新派发）`);
    }
  }

  /** 绑定 commands 服务并开始扫描；服务被卸载时 detach。 */
  attach(child) {
    if (this.disposed || this.started) return;
    const runtime = child && child.commands;
    if (!runtime || typeof runtime.register !== 'function') {
      warn('宿主没有可用的 commands 服务，命令不启用');
      return;
    }
    this.commands = runtime;
    this.started = true;

    // commands 服务换了/卸载了：注销并停掉本地 watcher，等下一次 attach
    if (typeof child.effect === 'function') {
      try {
        child.effect(() => () => this.detach(), 'agentflow: commands-runtime');
      } catch (err) {
        warn('监听 commands 服务生命周期失败（已忽略）：' + errorText(err));
      }
    }

    // Agent Teams 是可选的：装上才能 /off 时中断 teammate，没装就只是不中断
    try {
      if (typeof child.inject === 'function') {
        child.inject(['agentTeams'], (teamCtx) => {
          this.agentTeams = teamCtx && teamCtx.agentTeams ? teamCtx.agentTeams : null;
          if (teamCtx && typeof teamCtx.effect === 'function') {
            teamCtx.effect(() => () => {
              this.agentTeams = null;
            }, 'agentflow: agentTeams');
          }
        });
      }
    } catch (err) {
      warn('挂载 Agent Teams 失败（已忽略，/off 不会中断 teammate）：' + errorText(err));
    }

    this.ready = this.reload();
    this.installHooks(child);
    void this.loadPersistedRuns();
    this.startWatch();
    this.startPoll();
  }

  /** 停掉 watcher/定时器、摘掉钩子并注销全部命令；保留 modes（服务重载回来还能记住用户在哪张画布）。 */
  detach() {
    this.stopWatch();
    this.stopPoll();
    for (const dispose of this.hookDisposers.splice(0)) {
      try {
        dispose?.();
      } catch (err) {
        warn('摘除工作流钩子失败（已忽略）：' + errorText(err));
      }
    }
    for (const name of [...this.registered.keys()]) this.unregister(name);
    this.commands = null;
    this.started = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.modes.clear();
    this.runCounts.clear();
    this.warned.clear();
  }

  startWatch() {
    // 命令目录可能还不存在（引擎侧从没生成过命令）：自己建一个空目录，
    // 这样 fs.watch 有稳定的监听目标，引擎之后写文件就能立刻看到。
    try {
      fs.mkdirSync(this.commandsDir, { recursive: true });
    } catch (err) {
      warn('创建命令目录失败（不致命）：' + errorText(err));
    }
    try {
      this.watcher = fs.watch(this.commandsDir, { persistent: false }, () => this.scheduleReload());
      if (typeof this.watcher.on === 'function') {
        this.watcher.on('error', (err) => warn('命令目录监听中断，靠轮询兜底：' + errorText(err)));
      }
    } catch (err) {
      warn('命令目录监听失败，靠 10s 轮询兜底：' + errorText(err));
    }
  }

  stopWatch() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* 关不掉也没有补救动作 */
      }
      this.watcher = null;
    }
  }

  startPoll() {
    this.pollTimer = setInterval(() => void this.reload(), this.pollMs);
    // 不拖住进程退出（测试/一次性宿主尤其需要）
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
  }

  stopPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 200ms 防抖：一次保存触发的多个 fs 事件合并成一次全量 diff。 */
  scheduleReload() {
    if (this.disposed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.reload();
    }, this.debounceMs);
    if (typeof this.debounceTimer.unref === 'function') this.debounceTimer.unref();
  }

  /** 串行化 reload：watch 事件、轮询、手动调用互不重入。 */
  reload() {
    if (this.disposed || !this.commands) return Promise.resolve();
    this.chain = this.chain.catch(() => {}).then(() => this.reloadOnce());
    return this.chain;
  }

  async reloadOnce() {
    if (this.disposed || !this.commands) return;
    let desired;
    try {
      desired = await this.scan();
    } catch (err) {
      warn('扫描命令目录失败（保持现状）：' + errorText(err));
      return;
    }
    // null = 画布索引暂时读不出来：不做任何注销，等下一次扫描
    if (desired === null) return;
    if (this.disposed || !this.commands) return;

    // 先注销「消失」和「变了」的，再注册新的：重复注册前必须先 dispose 旧的
    for (const [name, previous] of [...this.registered]) {
      const next = desired.get(name);
      if (next && next.signature === previous.signature) continue;
      this.unregister(name);
    }
    for (const [name, entry] of desired) {
      if (this.registered.has(name) || this.disposed || !this.commands) continue;
      try {
        const dispose = this.commands.register({
          name,
          description: entry.description,
          input: { hint: INPUT_HINT },
          handler: this.makeHandler(entry),
        });
        this.registered.set(name, {
          dispose,
          signature: entry.signature,
          description: entry.description,
          boardId: entry.boardId,
        });
      } catch (err) {
        warn(`注册 /${name} 失败（已跳过）：${errorText(err)}`);
      }
    }
  }

  unregister(name) {
    const previous = this.registered.get(name);
    this.registered.delete(name);
    if (!previous) return;
    try {
      previous.dispose?.();
    } catch (err) {
      warn(`注销 /${name} 失败（已忽略）：${errorText(err)}`);
    }
  }

  /**
   * 全量扫描：命令文件 + boards.json + 画布文件 → desired Map。
   * @returns {Promise<Map<string, object>|null>} null 表示索引暂时不可读，本轮不动
   */
  async scan() {
    const index = await this.readBoardsIndex();
    if (index === null) return null;

    let files;
    try {
      files = await fsp.readdir(this.commandsDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return new Map();
      warn('读命令目录失败（保持现状）：' + errorText(err));
      return null;
    }

    const desired = new Map();
    for (const file of files.sort()) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      const full = path.join(this.commandsDir, file);
      const fallback = file.slice(0, -'.json'.length);

      let raw;
      try {
        raw = JSON.parse(await fsp.readFile(full, 'utf8'));
      } catch (err) {
        this.warnOnce(`parse:${file}`, `命令文件损坏，已跳过 ${file}：${errorText(err)}`);
        continue;
      }
      const record = normalizeCommandRecord(raw, fallback);
      if (!record) {
        this.warnOnce(`record:${file}`, `命令文件格式不对，已跳过 ${file}`);
        continue;
      }

      const meta = index.get(record.board);
      // boards.json 里没有这张画布：命令失效，静默跳过（画布被删是正常操作）
      if (!meta) continue;

      const boardFile = path.join(this.dataDir, 'boards', `${record.board}.json`);
      let boardRaw;
      try {
        boardRaw = JSON.parse(await fsp.readFile(boardFile, 'utf8'));
      } catch (err) {
        this.warnOnce(
          `board:${record.board}`,
          `画布 ${record.board} 读不到，命令 ${record.name} 已跳过：${errorText(err)}`,
        );
        continue;
      }

      const board = normalizeBoard(boardRaw, record.board);
      const boardName = board.name || meta.name || record.board;
      board.name = boardName;
      desired.set(record.name, {
        name: record.name,
        boardId: record.board,
        boardName,
        board,
        description: `进入「${boardName}」工作流`,
        signature: `${record.board}|${boardName}|${await signatureOf(full, boardFile)}`,
      });
    }
    return desired;
  }

  /**
   * 读 boards.json → Map<id, {id,name}>。
   * ENOENT = 还没有画布（空 Map）；解析失败 = null（本轮保持现状，别把命令全注销）。
   */
  async readBoardsIndex() {
    const file = path.join(this.dataDir, 'boards.json');
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (err) {
      if (err && err.code === 'ENOENT') return new Map();
      this.warnOnce('boards-json', '画布索引读不到，命令先保持现状：' + errorText(err));
      return null;
    }
    const out = new Map();
    const boards = raw && typeof raw === 'object' ? raw.boards : null;
    if (Array.isArray(boards)) {
      for (const item of boards) {
        if (item && item.id !== undefined) {
          out.set(String(item.id), { id: String(item.id), name: asString(item.name) });
        }
      }
    } else if (boards && typeof boards === 'object') {
      for (const id of Object.keys(boards)) {
        const item = boards[id] && typeof boards[id] === 'object' ? boards[id] : {};
        out.set(String(id), { id: String(id), name: asString(item.name) });
      }
    }
    return out;
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    warn(message);
  }

  /** 当前 agent 的进行中 run；历史遗留的字符串值一律当没有（只记过画布）。 */
  activeRun(agent) {
    const value = this.modes.get(agentKey(agent));
    return value && typeof value === 'object' && isActive(value) ? value : null;
  }

  /** 工具用：拿这个 agent 记着的 run（可能已结束/卡住），没有或旧格式返回 null。 */
  getRun(agentId) {
    const value = this.modes.get(String(agentId ?? ''));
    return value && typeof value === 'object' ? value : null;
  }

  /** 唯一注入动作：异常只 warn，绝不让 hook/命令抛到宿主。 */
  steer(agent, text) {
    if (!text) return false;
    if (!agent || typeof agent.steer !== 'function') return false;
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    return true;
  }

  /** 命令 handler：off 退出 / 空输入看画布 / 其它按画布 DAG 开一个 run。 */
  makeHandler(entry) {
    return (invocation) => {
      try {
        const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : '';
        const text = rawInput.trim();
        const agent = invocation?.agent;
        const key = agentKey(agent);

        if (/^off$/i.test(text)) {
          const stopping = this.activeRun(agent);
          this.modes.delete(key);
          this.persistRun(key, null);
          const stopped = stopping ? this.interruptSpawned(agent, stopping) : 0;
          return {
            kind: 'success',
            text: `已退出「${entry.boardName}」工作流${stopped > 0 ? `，已中断 ${stopped} 个 teammate` : ''}`,
          };
        }

        if (!text) {
          return { kind: 'success', text: buildCanvasText(entry.name, entry.board) };
        }

        // 同一个 agent 同时只允许一个 run：静默覆盖会让上一轮的 teammate 和状态全部失联
        if (this.activeRun(agent)) {
          return {
            kind: 'error',
            text: `已有进行中的画布工作流，先 /${entry.name} off 或等它结束`,
          };
        }
        if (!agent || typeof agent.steer !== 'function') {
          return { kind: 'error', text: '当前宿主不支持注入消息，画布工作流无法开始' };
        }

        // Agent Teams 的 roster 名字不复用（跨 DSH 重启亦然），所以 teammate 名由
        // createRun 生成的随机后缀保证唯一；runIndex 只作诊断，不参与命名。
        const runIndex = (this.runCounts.get(key) ?? 0) + 1;
        const run = createRun({
          board: entry.board,
          boardId: entry.boardId,
          boardName: entry.boardName,
          seed: text,
          ownerId: key,
          runIndex,
        });
        if (!run.rootId) {
          return {
            kind: 'error',
            text: `画布「${entry.boardName}」没有入口节点（没有调度卡，也没有唯一的无上游节点），这次工作流没法开始`,
          };
        }
        if (!isActive(run)) {
          return {
            kind: 'error',
            text: `画布「${entry.boardName}」没有可执行的节点（${run.stuck || '所有节点任务为空'}），这次工作流没法开始`,
          };
        }
        this.runCounts.set(key, runIndex);
        this.modes.set(key, run);
        this.persistRun(key, run);
        this.steer(agent, startInstruction(run));
        return { kind: 'success', text: `已进入画布「${entry.boardName}」，根节点开始` };
      } catch (err) {
        warn(`/${entry.name} 执行失败：${errorText(err)}`);
        return { kind: 'error', text: `命令执行失败：${errorText(err)}` };
      }
    };
  }

  // ---- 工作流钩子：pre-step 提醒 / turn-stopping 推进 / pre-execute 收口派发 / post-execute 记账 ----

  /** 在 commands 的同一个 inject child 上挂四个钩子；服务卸载时随 detach 摘掉。 */
  installHooks(child) {
    if (!child || typeof child.on !== 'function') return;
    const register = (event, listener) => {
      try {
        const dispose = child.on(event, listener);
        if (typeof dispose === 'function') this.hookDisposers.push(dispose);
      } catch (err) {
        warn(`挂 ${event} 钩子失败（已忽略）：${errorText(err)}`);
      }
    };

    register('agent/pre-step', async (payload, next) => {
      // waterfall 纪律：先让下游决定，绝不改结果类型；只有 enter 分支才追加提示
      const decision = await next();
      if (!decision || decision.kind === 'reject') return decision;
      try {
        const run = this.activeRun(payload?.agent);
        if (!run) return decision;
        // 状态没变就不再注入：同样的提示重复塞进历史只是白烧 token
        const signature = hintSignature(run);
        if (!signature || run.lastHintSignature === signature) return decision;
        run.lastHintSignature = signature;
        const hint = stepHint(run);
        if (!hint) return decision;
        const note = createUserMessage({ content: [{ type: 'text', text: hint }], source: { kind: 'user' } });
        return {
          ...decision,
          messages: [...(Array.isArray(decision.messages) ? decision.messages : []), note],
        };
      } catch (err) {
        warn('pre-step 注入画布提示失败（已忽略）：' + errorText(err));
        return decision;
      }
    });

    register('agent/turn-stopping', (payload) => {
      try {
        const agent = payload?.agent;
        const run = this.activeRun(agent);
        if (!run) return;

        // a. 有该派发的：先按未标记状态生成指令，steer 成功后才记为「已请求」
        const layer = toDispatch(run);
        if (layer.length > 0) {
          const instruction = dispatchInstruction(run);
          if (this.steer(agent, instruction)) {
            markRequested(run, layer.map((node) => node.id));
            this.persistRun(agentKey(agent), run);
          }
          return;
        }

        // b. 请求过派发、但还没看到成功的 spawn：超时后催一次（不要每步刷）
        const awaiting = awaitingSpawn(run);
        if (awaiting.length > 0) {
          // 同一个 turn 先立刻催一次（不然模型直接结束时，没有下一个 turn，
          // 120s 超时永远等不到）；之后才走超时重试。
          const stale = Date.now() - run.lastAdvanceAt > SPAWN_RETRY_MS;
          const fresh = run.spawnNudgeTurn !== payload?.turn;
          if (!stale && !fresh) return;
          const names = awaiting.map((nodeId) => spawnNameFor(run, nodeId));
          const reminder =
            `【AgentFlow】这些节点还没建 teammate：${names.join('、')}（名字由节点 id 生成）。` +
            '请先 spawn_teammate 把它们建出来，再等回报；不要自己代做这些节点。';
          if (this.steer(agent, reminder)) {
            run.lastAdvanceAt = Date.now();
            run.spawnNudgeTurn = payload?.turn;
          }
          return;
        }

        // c. 根节点还没声明完成：同一个 turn 最多催一次，避免每步刷屏
        if (run.status.get(run.rootId) === FLOW_STATES.STATE_PENDING) {
          if (run.rootNudgeTurn === payload?.turn) return;
          const nudged = this.steer(
            agent,
            `【AgentFlow】根节点 ${run.rootId} 还没完成：做完请调 agentflow_node_done(node_id="${run.rootId}", output="实际产出")，不调不算完成。`,
          );
          if (nudged) run.rootNudgeTurn = payload?.turn;
          return;
        }

        // d. 已全部完成 / 正在等 teammate 回报：不 steer，让它自然结束
      } catch (err) {
        warn('turn-stopping 推进画布失败（已忽略）：' + errorText(err));
      }
    });

    register('tools/pre-execute', (exec, next) => {
      // 只拦 spawn_teammate；其它工具/没有 run 的 agent 一律放行
      let veto = null;
      try {
        if (exec && exec.name === 'spawn_teammate') {
          const run = this.activeRun(exec.agent);
          if (run) {
            const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
            const name = typeof args.name === 'string' ? args.name.trim() : '';
            // 允许的名字只能来自 spawnNameFor：派发指令、pre-execute、超时提醒共用同一套名字
            const ids = [...new Set([...run.requested, ...run.spawned])];
            const names = ids.map((nodeId) => spawnNameFor(run, nodeId));
            if (!name || !names.includes(name)) {
              veto = {
                kind: 'deny',
                reason: `当前层只允许派发这些名字：${names.join('、') || '无'}（名字由节点 id 生成，可用节点 id 反查；不要直接用节点 id 当 teammate 名）`,
              };
            }
          }
        }
      } catch (err) {
        warn('pre-execute 校验派发失败（已忽略，放行）：' + errorText(err));
      }
      return veto ?? next();
    });

    register('tools/post-execute', async (exec, result, next) => {
      // 第二个参数才是工具真实结果；next() 返回的是决策对象（只有 kind）
      try {
        if (exec && exec.name === 'spawn_teammate') {
          const run = this.activeRun(exec.agent);
          if (run) {
            const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
            const name = typeof args.name === 'string' ? args.name.trim() : '';
            const nodeId = name ? nodeForSpawnName(run, name) : '';
            if (nodeId && result && !result.isError) {
              // 命不中本 run 的节点名就忽略：这是 dispatched 的唯一真实来源
              markSpawned(run, nodeId);
              this.persistRun(agentKey(exec.agent), run);
            } else if (nodeId && result && result.isError && isNameTaken(result)) {
              // 撞名（概率极低但存在）：换一个新名字，让 turn-stopping 重派一次
              const fresh = regenerateSpawnName(run, nodeId);
              this.persistRun(agentKey(exec.agent), run);
              if (fresh) {
                warn(`teammate 名被占用，已为节点 ${nodeId} 换名：${fresh}`);
                this.steer(
                  exec.agent,
                  `【AgentFlow】节点 ${nodeId} 的 teammate 名被占用了，已换成 "${fresh}"。请用这个新名字重新 spawn_teammate。`,
                );
              }
            }
          }
        }
      } catch (err) {
        warn('post-execute 记录 spawn 失败（已忽略）：' + errorText(err));
      }
      return next();
    });
  }
}

/**
 * roster 撞名的判定：Agent Teams 用 TEAM_MEMBER_NAME_TAKEN，但错误可能被包成
 * 普通文本，所以同时认错误码与原文关键词。
 */
function isNameTaken(result) {
  const texts = [];
  if (result && Array.isArray(result.content)) {
    for (const block of result.content) if (block && typeof block.text === 'string') texts.push(block.text);
  }
  if (result && result.error && typeof result.error.message === 'string') texts.push(result.error.message);
  if (result && typeof result.error === 'string') texts.push(result.error);
  const joined = texts.join('\n');
  return /TEAM_MEMBER_NAME_TAKEN|already used in this Team|已经用过|名字.*占用/i.test(joined);
}

/**
 * agentflow_node_done：完成当前画布节点必须调用，不调用视为未完成。
 * 全局注册；handler 里按 run.ownerId 校验 —— 只有发起这次 run 的 agent 能标记。
 *
 * @param {(agentId: string) => object|null} getRun 按 agent id 取 run
 */
export function createNodeDoneTool(getRun, onChange) {
  return defineTool({
    name: 'agentflow_node_done',
    description:
      '完成当前画布节点必须调用，不调用视为未完成。交回节点 id 与该节点的实际产出（>=10 字）；只有发起这次画布工作流的 agent 能调用。每完成一个节点调用一次，按返回的提示继续下一层。',
    parameters: {
      node_id: {
        type: 'string',
        required: true,
        description: '要标记完成的画布节点 id（当前层「当前可做」里的一个）',
      },
      output: {
        type: 'string',
        required: true,
        description: '该节点的实际产出正文（>=10 字）：结论、清单或关键内容，不要只写「完成」',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      try {
        const agent = exec?.agent;
        const agentId = agentKey(agent);
        const run = typeof getRun === 'function' ? getRun(agentId) : null;
        const notify = typeof onChange === 'function' ? onChange : null;
        if (!run || !isActive(run)) {
          return { text: '当前没有工作流。先用 /agentflow-xxx <要做的事> 进入一张画布。' };
        }
        if (run.ownerId && run.ownerId !== agentId) {
          return { text: `${statusLine(run)}\n不行：只有发起这次画布工作流的 agent（${run.ownerId}）能标记节点完成。` };
        }
        const nodeId = typeof args?.node_id === 'string' ? args.node_id.trim() : '';
        const output = typeof args?.output === 'string' ? args.output : '';
        if (!nodeId) return { text: `${statusLine(run)}\n不行：缺 node_id，传当前要完成的节点 id。` };
        const result = markDone(run, nodeId, output);
        // 每次状态变化都落盘：DSH 重启后还能从断点续跑（结束/卡住就清文件）
        if (notify) {
          try {
            notify(agentId, run);
          } catch {
            /* 落盘失败不影响本次标记 */
          }
        }
        if (!result.ok) return { text: `${statusLine(run)}\n不行：${result.reason}` };
        const status = statusLine(run);
        if (result.state === 'done') return { text: `${status}\n${summaryInstruction(run)}` };
        if (result.state === 'stuck') return { text: `${status}\n卡住：${run.stuck}` };
        return { text: `${status}\n继续：${stepHint(run)}` };
      } catch (err) {
        return { text: `agentflow_node_done 出错（未标记任何节点）：${errorText(err)}` };
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `agentflow_node_done · ${args?.node_id ?? '?'}`,
      kind: 'other',
      rawInput: { node_id: args?.node_id },
    }),
  });
}

/** 文件签名：mtime + 大小。画布改了/命令重写了都要重注册，保证描述与摘要不过期。 */
async function signatureOf(...files) {
  const parts = [];
  for (const file of files) {
    try {
      const stat = await fsp.stat(file);
      parts.push(`${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push('missing');
    }
  }
  return parts.join('|');
}

/**
 * 启动命令热注册。
 *
 * @param {object} ctx 插件上下文（需要 ctx.inject；极简宿主可直接给 ctx.commands）
 * @param {object} options
 * @param {string} options.dir 引擎 runtime 目录（保留给诊断信息，不 import 引擎）
 * @param {string} options.dataDir 数据根目录（命令目录内部拼成 <dataDir>/commands）
 * @param {number} [options.pollMs] 轮询间隔，默认 10000
 * @param {number} [options.debounceMs] watch 防抖，默认 200
 * @returns {{dispose: () => void, reload: () => Promise<void>, ready: Promise<void>|null, registered: Map, modes: Map, getRun: (agentId: string) => object|null}}
 */
export function startCommands(ctx, options = {}) {
  const config = options && typeof options === 'object' ? options : {};
  const dataDir = typeof config.dataDir === 'string' && config.dataDir ? path.resolve(config.dataDir) : '';
  if (!dataDir) {
    warn('缺少 dataDir，命令不启用');
    return inert();
  }

  const session = new CommandSession({ ...config, dataDir });
  const apiOf = (dispose) => ({
    dispose,
    reload: () => session.reload(),
    get ready() {
      return session.ready;
    },
    get registered() {
      return session.registered;
    },
    get modes() {
      return session.modes;
    },
    getRun: (agentId) => session.getRun(agentId),
    /** 节点完成后把最新状态落盘（index.js 的 node_done 工具回调） */
    persistRun: (agentId, run) => session.persistRun(agentId, run),
  });

  // 极简宿主（测试桩/嵌入）可能直接带 commands、没有 cordis 的 inject
  if (!ctx || typeof ctx.inject !== 'function') {
    if (ctx && ctx.commands && typeof ctx.commands.register === 'function') {
      session.attach(ctx);
      return apiOf(() => session.dispose());
    }
    warn('宿主没有 ctx.inject，命令不启用');
    return inert();
  }

  let fiber = null;
  try {
    fiber = ctx.inject(['commands'], (child) => {
      session.attach(child);
    });
  } catch (err) {
    warn('挂载 commands 服务失败，命令不启用：' + errorText(err));
  }

  return apiOf(() => {
    // 先停本地 watcher/定时器，再让 cordis 回收注入的 child fiber
    try {
      session.dispose();
    } catch (err) {
      warn('卸载命令失败（已忽略）：' + errorText(err));
    }
    try {
      const result = fiber && typeof fiber.dispose === 'function' ? fiber.dispose() : null;
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch {
      /* 卸载失败没有补救动作 */
    }
  });
}

export default startCommands;
