/**
 * 观察器（阶段 1）：只记录，不拦不改。
 *
 * 为什么先观察：在动手做「强制工作流」之前，得先看清模型实际怎么走 ——
 * 每步进了哪些消息、调了哪个工具、参数长什么样、成功还是被拒、哪一步收工。
 * 没这份数据就设计白名单，等于闭着眼画闸门。
 *
 * 挂在三个官方钩子上（都是 waterfall/serial，回调必须原样把下游结果返回）：
 *   agent/pre-step         看每一步的输入与决策
 *   tools/post-execute     看每一次工具调用（含被 deny 的，deny 也过这条管线）
 *   agent/turn-stopping    看模型在哪里收工
 *
 * 落盘：`<root>/<agent>.jsonl`，一行一个事件，方便 jq 或脚本直接看。
 *    {t:'step', turn, step, msgs:[{kind,form,chars}], decision:{kind,msgs}}
 *    {t:'tool', turn, step, name, args, ms, isError, text}
 *    {t:'stop', turn}
 *
 * 纪律：所有写入 fire-and-forget，任何异常只 warn。
 * 观察器坏了不能连累对话 —— 钩子里抛错会直接结束当前 turn。
 *
 * @module lib/observe
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 单条文本/参数最多记多少字符：够判断意图，又不至于把日志灌爆。 */
const MAX_TEXT = 240;
/** 单个 agent 最多记多少行，防止长会话把盘写满。 */
const MAX_LINES = 5000;

/** 默认落盘目录，跟画布数据放一起。 */
const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'agent-flow-data', 'observe');

/** 把任意值压成一行可读文本；循环引用/巨对象都不许抛。 */
function asText(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '(unserializable)';
    }
  }
}

/** 截断到 MAX_TEXT（或指定长度），末尾加省略号。 */
function clip(value, limit = MAX_TEXT) {
  const text = asText(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 一条消息里所有 text block 的字符数 —— 只看体量，不存正文。 */
function messageChars(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  let total = 0;
  for (const block of content) {
    if (block && typeof block.text === 'string') total += block.text.length;
  }
  return total;
}

/**
 * 消息摘要：谁产的（source.kind）、什么形态（form）、多大。
 * 不存正文 —— 对话内容留在 DSH 自己的 session log 里，这里只留形状。
 */
function describeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => ({
    kind: message?.source?.kind ?? '?',
    form: message?.source?.form,
    chars: messageChars(message),
  }));
}

/** 工具结果的可读摘要：优先纯文本内容，其次 value，最后错误信息。 */
function describeResult(result) {
  if (!result || typeof result !== 'object') return '';
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
      .join(' ')
      .trim();
    if (text) return text;
  }
  if (result.value !== undefined) return asText(result.value);
  if (result.error && typeof result.error.message === 'string') return result.error.message;
  return '';
}

/** 文件名安全化：agent id 是宿主给的，别让它逃出目录。 */
function safeFileName(agentId) {
  return String(agentId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'agent';
}

/** agent 身份：本体 id 就是 session id。 */
function agentKey(agent) {
  return agent && agent.id !== undefined ? String(agent.id) : 'unknown';
}

/**
 * 每 agent 一个 append 串行队列。
 * 不串行的话并发工具调用会把行写乱（appendFile 本身原子，但顺序会漂）。
 */
class JsonlWriter {
  constructor(root) {
    this.root = root;
    this.chains = new Map();
    this.counts = new Map();
    this.dirReady = null;
  }

  async ensureDir() {
    if (this.dirReady === null) {
      this.dirReady = fsp.mkdir(this.root, { recursive: true }).catch((err) => {
        this.dirReady = null; // 允许下一行重试
        throw err;
      });
    }
    return this.dirReady;
  }

  /** 记一行。同步返回，绝不 await —— 钩子里不能因为落盘慢拖住对话。 */
  append(agentId, event) {
    const key = safeFileName(agentId);
    const count = this.counts.get(key) ?? 0;
    if (count >= MAX_LINES) return;
    this.counts.set(key, count + 1);

    const file = path.join(this.root, `${key}.jsonl`);
    const line = `${JSON.stringify(event)}\n`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await this.ensureDir();
        await fsp.appendFile(file, line);
      })
      .catch((err) => {
        console.warn('[agentflow] 观察记录写失败（已忽略）：' + (err && err.message ? err.message : err));
      });
    this.chains.set(key, next);
    return next;
  }

  /** 测试与卸载用：等所有在途写入落完。 */
  async flush() {
    await Promise.all([...this.chains.values()]);
  }
}

/**
 * 挂上观察器。
 *
 * @param {object} ctx 插件上下文（只用 ctx.on）
 * @param {object} [options]
 * @param {string} [options.root] 落盘目录，默认 `~/.dsh/agent-flow-data/observe`
 * @param {(agentId: string, event: object) => void} [options.sink] 替代落盘（测试用）
 * @returns {{ dispose: () => void, flush: () => Promise<void> }}
 */
export function startObserver(ctx, options = {}) {
  // 没有 ctx.on 的宿主（极简嵌入、测试桩）不该让整个插件加载失败：
  // 观察器只是旁路，缺了这个能力就当它不存在。
  if (typeof ctx?.on !== 'function') {
    console.warn('[agentflow] 宿主没有 ctx.on，观察器不启用');
    return { dispose() {}, flush: async () => {} };
  }

  const writer = new JsonlWriter(options.root || DEFAULT_ROOT);
  const sink = typeof options.sink === 'function' ? options.sink : null;
  /** exec.token -> 真实执行耗时（由 tools/execute 记，post-execute 消费后删除）。 */
  const timings = new Map();
  /** 当前 agent 走到第几步 —— 工具调用本身不带 turn/step，得靠 pre-step 记住。 */
  const position = new Map();
  const disposers = [];

  const write = (agentId, event) => {
    if (sink) {
      try {
        sink(agentId, event);
      } catch (err) {
        console.warn('[agentflow] 观察 sink 失败（已忽略）：' + (err && err.message ? err.message : err));
      }
      return;
    }
    void writer.append(agentId, event);
  };

  // ---- 每一步的输入与决策 -------------------------------------------------
  disposers.push(
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next(); // 先让下游决定，观察器永远不改结果
      try {
        const agentId = agentKey(payload?.agent);
        position.set(agentId, { turn: payload?.turn, step: payload?.step });
        write(agentId, {
          t: 'step',
          at: Date.now(),
          agent: agentId,
          turn: payload?.turn,
          step: payload?.step,
          msgs: describeMessages(payload?.messages),
          decision:
            decision && decision.kind === 'reject'
              ? { kind: 'reject' }
              : { kind: decision?.kind ?? '?', msgs: describeMessages(decision?.messages) },
        });
      } catch (err) {
        console.warn('[agentflow] 观察 step 失败（已忽略）：' + (err && err.message ? err.message : err));
      }
      return decision;
    }),
  );

  // ---- 每一次工具调用（deny 也过这条管线） -------------------------------
  // 第二个参数 `_result` 才是工具真实结果（content/isError/error）；
  // next() 返回的是管线决策对象，只有 kind，不能当结果记。
  disposers.push(
    // 真实耗时只能在 around-dispatch 这一层量：post-execute 的 next() 只回决策，
    // 它包住的不是工具执行本身（早期版本因此把 ms 全记成了 0）。
    ctx.on('tools/execute', async (exec, next) => {
      const token = exec && exec.token;
      const startedAt = Date.now();
      try {
        return await next();
      } finally {
        if (token !== undefined) timings.set(token, Date.now() - startedAt);
      }
    }),
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const started = Date.now();
      const downstream = await next();
      try {
        const agentId = agentKey(exec?.agent);
        const spot = position.get(agentId) ?? {};
        const result = _result && typeof _result === 'object' ? _result : {};
        write(agentId, {
          t: 'tool',
          at: started,
          agent: agentId,
          turn: spot.turn,
          step: spot.step,
          name: exec?.name ?? '?',
          args: clip(exec?.arguments, 300),
          ms: (exec && exec.token !== undefined && timings.get(exec.token)) || 0,
          isError: Boolean(result.isError),
          text: clip(describeResult(result), 200),
        });
        if (exec && exec.token !== undefined) timings.delete(exec.token);
      } catch (err) {
        console.warn('[agentflow] 观察 tool 失败（已忽略）：' + (err && err.message ? err.message : err));
      }
      return downstream;
    }),
  );

  // ---- 模型想收工的地方 ---------------------------------------------------
  disposers.push(
    ctx.on('agent/turn-stopping', (payload) => {
      try {
        const agentId = agentKey(payload?.agent);
        write(agentId, { t: 'stop', at: Date.now(), agent: agentId, turn: payload?.turn });
      } catch (err) {
        console.warn('[agentflow] 观察 stop 失败（已忽略）：' + (err && err.message ? err.message : err));
      }
    }),
  );

  return {
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 卸载失败没有补救动作 */
        }
      }
      disposers.length = 0;
    },
    flush: () => writer.flush(),
  };
}

export default startObserver;
