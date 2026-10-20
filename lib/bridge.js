/**
 * llm bridge —— DSH 进程内的本地模型通道。
 *
 * AgentFlow server 通过 HTTP/SSE 调这里，这里只做协议翻译，不碰任何 provider：
 *   GET  /health   活着吗
 *   GET  /catalog  DSH 的 provider/模型目录（含推理档位）
 *   POST /stream   ctx.llm.stream 的 SSE 转发
 *
 * 契约是唯一真相源：~/.dsh/agent-flow/docs/bridge-contract.md。
 * 几个刻意的取舍：
 *   - 只绑 127.0.0.1，且只认本机 Host（防 DNS rebinding）
 *   - token 每次启动随机；发现文件由调用方读，所以端口被占就 listen(0)
 *   - 插件在 DSH 主进程里，绝不写 stdout，异常一律 console.warn
 *   - 流事件只发 delta/tool/usage/done/error，reasoning-delta 丢弃
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 契约规定的默认端口；被占用时回落到随机端口。 */
export const DEFAULT_PORT = 8792;
/** POST /stream 请求体上限。 */
export const MAX_BODY_BYTES = 1024 * 1024;
/** 同时进行的流式调用上限。 */
export const MAX_CONCURRENT_STREAMS = 8;
/** 单请求超时（10 分钟）。 */
export const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** /catalog 缓存时间（契约要求 ≤ 10 秒）。 */
export const CATALOG_TTL_MS = 10 * 1000;

const DEFAULT_DIR = path.join(os.homedir(), '.dsh', 'agent-flow');
const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i;

/** 发现文件路径：<agentflowDir>/data/dsh-bridge.json */
export function bridgeInfoPath(dir) {
  return path.join(dir, 'data', 'dsh-bridge.json');
}

/**
 * 启动 bridge。同步返回 disposer：服务监听与发现文件写入都是后台完成的，
 * 失败只 warn，不阻塞、不抛错（插件加载比 bridge 可用更重要）。
 *
 * @param {{llm: object}} ctx DSH 插件上下文（用到 ctx.llm）
 * @param {object} [options]
 * @param {string} [options.dir] AgentFlow 目录，默认 ~/.dsh/agent-flow
 * @param {number} [options.port] 首选端口，默认 8792；显式 0 表示直接随机
 * @param {number} [options.requestTimeoutMs] 单请求超时（测试用）
 * @param {number} [options.catalogTtlMs] 目录缓存时长（测试用）
 * @returns {() => Promise<void>} disposer
 */
export function startBridge(ctx, options = {}) {
  if (!ctx || !ctx.llm) {
    console.warn('[agentflow] 缺少 ctx.llm，llm bridge 未启动');
    return async () => {};
  }

  const dir = typeof options.dir === 'string' && options.dir ? options.dir : DEFAULT_DIR;
  const preferredPort = Number.isInteger(options.port) && options.port >= 0 ? options.port : DEFAULT_PORT;
  const requestTimeoutMs =
    Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : REQUEST_TIMEOUT_MS;
  const catalogTtlMs =
    Number.isFinite(options.catalogTtlMs) && options.catalogTtlMs >= 0 ? options.catalogTtlMs : CATALOG_TTL_MS;

  const state = {
    ctx,
    dir,
    token: crypto.randomBytes(24).toString('base64url'),
    startedAt: Date.now(),
    infoFile: bridgeInfoPath(dir),
    port: 0,
    requestTimeoutMs,
    catalogTtlMs,
    inflight: 0,
    streams: new Set(),
    catalog: null,
    catalogAt: 0,
    catalogInFlight: null,
    warnedModels: new Set(),
    stopped: false,
    ready: null,
  };

  const server = http.createServer((req, res) => {
    handleRequest(state, req, res).catch((err) => {
      console.warn('[agentflow] bridge 处理请求失败：' + errorMessage(err));
      if (!res.headersSent) {
        sendJson(res, 500, { error: errorMessage(err) });
      } else {
        try {
          res.end();
        } catch {}
      }
    });
  });

  // HTTP 解析失败（畸形请求）不能把主进程带崩
  server.on('clientError', (_err, socket) => {
    if (socket && socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    }
  });

  state.ready = (async () => {
    try {
      await listenOnce(server, preferredPort);
    } catch (err) {
      if (preferredPort !== 0 && err && err.code === 'EADDRINUSE') {
        await listenOnce(server, 0);
      } else {
        throw err;
      }
    }
    state.port = server.address().port;
    server.on('error', (err) => {
      if (!state.stopped) console.warn('[agentflow] bridge 服务错误：' + errorMessage(err));
    });
    if (state.stopped) {
      await closeServer(server);
      return;
    }
    await writeInfoFile(state);
  })().catch((err) => {
    console.warn('[agentflow] bridge 启动失败：' + errorMessage(err));
    closeServer(server).catch(() => {});
  });

  let closePromise = null;
  return function stop() {
    if (closePromise) return closePromise;
    state.stopped = true;
    for (const controller of state.streams) {
      try {
        controller.abort();
      } catch {}
    }
    state.streams.clear();
    closePromise = (async () => {
      try {
        await state.ready;
      } catch {}
      await closeServer(server);
      await removeInfoFile(state);
    })();
    return closePromise;
  };
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

async function handleRequest(state, req, res) {
  if (!isAuthorized(req, state.token)) {
    req.resume();
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  if (!isLocalHost(req.headers.host)) {
    req.resume();
    sendJson(res, 403, { error: 'bad host' });
    return;
  }

  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;

  if (req.method === 'GET' && pathname === '/health') {
    handleHealth(state, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/catalog') {
    await handleCatalog(state, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/stream') {
    await handleStream(state, req, res);
    return;
  }

  req.resume();
  sendJson(res, 404, { error: 'not found' });
}

function handleHealth(state, res) {
  let providers;
  try {
    providers = state.ctx.llm.listProviders();
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    pid: process.pid,
    providers: Array.isArray(providers) ? providers.length : 0,
  });
}

async function handleCatalog(state, res) {
  let catalog;
  try {
    catalog = await getCatalog(state);
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
    return;
  }
  sendJson(res, 200, catalog);
}

/** 目录缓存 + 单飞：同一时刻只允许一轮组装，失败不缓存。 */
function getCatalog(state) {
  const now = Date.now();
  if (state.catalog && now - state.catalogAt < state.catalogTtlMs) {
    return Promise.resolve(state.catalog);
  }
  if (state.catalogInFlight) return state.catalogInFlight;

  state.catalogInFlight = buildCatalog(state)
    .then((catalog) => {
      state.catalog = catalog;
      state.catalogAt = Date.now();
      return catalog;
    })
    .finally(() => {
      state.catalogInFlight = null;
    });
  return state.catalogInFlight;
}

async function buildCatalog(state) {
  const providers = state.ctx.llm.listProviders();
  if (!Array.isArray(providers)) throw new Error('/catalog：listProviders 没有返回数组');
  const entries = await Promise.all(providers.map((provider) => buildProviderEntry(state, provider)));
  return { providers: entries };
}

/**
 * 单条 provider 失败只写该条的 error；模型级 resolveModelInfo 失败则保留模型、
 * 档位给空（抓错，不抛），避免一个坏模型拖垮整个目录。
 */
async function buildProviderEntry(state, provider) {
  const id = stringOf(provider && provider.id);
  const entry = {
    id,
    label: stringOf(provider && provider.name) || id,
    models: [],
    error: null,
  };
  try {
    const models = await state.ctx.llm.listModels(id);
    for (const model of Array.isArray(models) ? models : []) {
      entry.models.push(await describeModel(state, id, model));
    }
  } catch (err) {
    entry.error = errorMessage(err);
  }
  return entry;
}

async function describeModel(state, provider, model) {
  const id = stringOf(model && model.id).trim();
  const entry = { id, name: stringOf(model && model.name) || id, levels: [], defaultLevel: '' };
  if (!id) return entry;

  try {
    const info = await state.ctx.llm.resolveModelInfo(provider, id);
    const reasoning = info && info.reasoning;
    const efforts = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
    if (efforts.length) {
      entry.levels = efforts.map((effort) => stringOf(effort && effort.id)).filter(Boolean);
      const preferred = stringOf(reasoning && reasoning.defaultEffort);
      entry.defaultLevel = preferred && entry.levels.includes(preferred) ? preferred : entry.levels[0] || '';
    }
  } catch (err) {
    const key = provider + '\u0000' + id;
    if (!state.warnedModels.has(key)) {
      state.warnedModels.add(key);
      console.warn(`[agentflow] bridge 解析模型信息失败（${provider}/${id}）：${errorMessage(err)}`);
    }
  }
  return entry;
}

// ---------------------------------------------------------------------------
// POST /stream
// ---------------------------------------------------------------------------

async function handleStream(state, req, res) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume();
    sendJson(res, 413, { error: 'body too large' });
    return;
  }
  if (state.inflight >= MAX_CONCURRENT_STREAMS) {
    req.resume();
    sendJson(res, 429, { error: 'bridge busy' });
    return;
  }

  state.inflight += 1;
  try {
    let raw;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        req.resume();
        sendJson(res, 413, { error: 'body too large' });
      } else if (!res.headersSent) {
        sendJson(res, 400, { error: errorMessage(err) });
      }
      return;
    }

    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      sendJson(res, 400, { error: 'bad json' });
      return;
    }

    let options;
    try {
      options = normalizeStreamRequest(body);
    } catch (err) {
      if (err instanceof BridgeRequestError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      throw err;
    }

    await streamResponse(state, res, options);
  } finally {
    state.inflight -= 1;
  }
}

/**
 * 把 ctx.llm.stream 的 StreamChunk 翻成契约里的五种事件。
 * 结束必须先发 done 或 error，再关流；客户端断开要 abort 底层调用。
 */
async function streamResponse(state, res, requestOptions) {
  const controller = new AbortController();
  const toolSlots = new Map();
  let clientGone = false;
  let timedOut = false;
  let terminal = false;
  let headersSent = false;

  state.streams.add(controller);
  const onClose = () => {
    if (!res.writableEnded) {
      clientGone = true;
      try {
        controller.abort();
      } catch {}
    }
  };
  res.on('close', onClose);

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort();
    } catch {}
  }, state.requestTimeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const send = (event) => {
    if (res.writableEnded || res.destroyed) return;
    if (!headersSent) {
      headersSent = true;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const finishWith = (event) => {
    if (terminal) return;
    terminal = true;
    if (!clientGone) send(event);
  };

  try {
    const stream = state.ctx.llm.stream({ ...requestOptions, signal: controller.signal });
    for await (const chunk of stream) {
      if (terminal) break;
      if (!chunk || typeof chunk !== 'object') continue;

      switch (chunk.type) {
        case 'text-delta':
          if (typeof chunk.text === 'string' && chunk.text) {
            send({ type: 'delta', text: chunk.text });
          }
          break;
        case 'tool-call-delta':
          accumulateToolDelta(toolSlots, chunk);
          break;
        case 'block-end': {
          const toolEvent = toolEventFromBlock(toolSlots, chunk);
          if (toolEvent) send(toolEvent);
          break;
        }
        case 'usage':
          send(usageEvent(chunk.usage));
          break;
        case 'finish':
          finishWith(finishEvent(chunk.reason, state, timedOut));
          break;
        default:
          // block-start / reasoning-delta / 未来新增的块类型：都不进物料正文
          break;
      }
    }

    if (!terminal) {
      if (timedOut) {
        finishWith({ type: 'error', message: timeoutMessage(state.requestTimeoutMs), code: 'BRIDGE_TIMEOUT' });
      } else if (clientGone) {
        finishWith({ type: 'error', message: '客户端已断开', code: 'ABORTED' });
      } else {
        finishWith({
          type: 'error',
          message: 'bridge 流提前结束（没有收到 finish）',
          code: 'STREAM_INCOMPLETE',
        });
      }
    }
  } catch (err) {
    if (timedOut) {
      finishWith({ type: 'error', message: timeoutMessage(state.requestTimeoutMs), code: 'BRIDGE_TIMEOUT' });
    } else {
      const code = stringOf(err && err.code);
      finishWith({
        type: 'error',
        message: errorMessage(err),
        ...(code ? { code } : {}),
      });
    }
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
    state.streams.delete(controller);
    try {
      res.end();
    } catch {}
  }
}

function accumulateToolDelta(slots, chunk) {
  const index = Number.isInteger(chunk.index) ? chunk.index : 0;
  const slot = slots.get(index) || { id: '', name: '', arguments: '' };
  if (typeof chunk.id === 'string' && chunk.id) slot.id = chunk.id;
  // 名字是整体下发（不是增量），后面再出现就覆盖
  if (typeof chunk.name === 'string' && chunk.name) slot.name = chunk.name;
  if (typeof chunk.argumentsDelta === 'string') slot.arguments += chunk.argumentsDelta;
  slots.set(index, slot);
}

/** block-end 携带组装好的 block；accumulator 兜底，防止 adapter 漏字段。 */
function toolEventFromBlock(slots, chunk) {
  const block = chunk.block;
  if (!block || block.type !== 'tool-call') return null;

  const index = Number.isInteger(chunk.index) ? chunk.index : 0;
  const slot = slots.get(index);
  slots.delete(index);

  const id = stringOf(block.id) || stringOf(slot && slot.id) || `call-${index}`;
  const name = stringOf(block.name) || stringOf(slot && slot.name) || '';
  const args =
    typeof block.arguments === 'string' ? block.arguments : stringOf(slot && slot.arguments) || '{}';

  return { type: 'tool', id, name, arguments: args };
}

function usageEvent(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const count = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  // DSH 的 inputTokens 不含缓存命中（三项互斥），promptTokens 取三者之和，
  // 与 provider 的 prompt_tokens 口径一致。
  return {
    type: 'usage',
    promptTokens: count(u.inputTokens) + count(u.cacheReadTokens) + count(u.cacheWriteTokens),
    completionTokens: count(u.outputTokens),
  };
}

function finishEvent(reason, state, timedOut) {
  const kind = stringOf(reason && reason.kind) || 'stop';
  const failure = reason && reason.failure;

  if (kind === 'aborted') {
    if (timedOut) {
      return { type: 'error', message: timeoutMessage(state.requestTimeoutMs), code: 'BRIDGE_TIMEOUT' };
    }
    const code = stringOf(failure && failure.code);
    return {
      type: 'error',
      message: stringOf(failure && failure.message) || '模型调用已中止',
      ...(code ? { code } : {}),
    };
  }

  if (kind === 'error') {
    const code = stringOf(failure && failure.code);
    return {
      type: 'error',
      message: stringOf(failure && failure.message) || '模型调用失败',
      ...(code ? { code } : {}),
    };
  }

  // stop / tool-calls / max-tokens（截断也是正常收尾）/ 未来新增的成功原因
  return { type: 'done' };
}

function timeoutMessage(ms) {
  if (ms >= 60_000 && ms % 60_000 === 0) return `bridge 请求超时（${ms / 60_000} 分钟）`;
  return `bridge 请求超时（${ms}ms）`;
}

// ---------------------------------------------------------------------------
// 请求体翻译：AgentFlow 的宽松结构 → DSH 的 RequestMessage / GenerateOptions
// ---------------------------------------------------------------------------

class BridgeRequestError extends Error {}
class BodyTooLargeError extends Error {}

function normalizeStreamRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BridgeRequestError('请求体必须是 JSON 对象');
  }

  const provider = requiredString(body.provider, 'provider');
  const model = requiredString(body.model, 'model');
  const options = {
    provider,
    model,
    messages: normalizeMessages(body.messages, provider, model),
  };

  if (body.reasoningEffort != null && body.reasoningEffort !== '') {
    if (typeof body.reasoningEffort !== 'string') {
      throw new BridgeRequestError('reasoningEffort 必须是字符串');
    }
    options.reasoningEffort = body.reasoningEffort;
  }

  if (body.system != null && body.system !== '') {
    if (typeof body.system !== 'string') {
      throw new BridgeRequestError('system 必须是字符串');
    }
    options.system = body.system;
  }

  const tools = normalizeTools(body.tools);
  if (tools) options.tools = tools;

  return options;
}

function requiredString(value, field) {
  const text = stringOf(value).trim();
  if (!text) throw new BridgeRequestError(`缺少 ${field}`);
  return text;
}

function normalizeMessages(messages, provider, model) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BridgeRequestError('messages 必须是非空数组');
  }
  return messages.map((message, index) => normalizeMessage(message, index, provider, model));
}

function normalizeMessage(message, index, provider, model) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new BridgeRequestError(`messages[${index}] 不是对象`);
  }
  const role = stringOf(message.role);

  if (role === 'user') {
    // RequestUserInput：不带 id/source，内容必须是块数组
    return { role, content: normalizeContent(role, message.content, index) };
  }

  if (role === 'system') {
    return {
      id: `af-${index}`,
      role,
      content: normalizeContent(role, message.content, index),
      source: { kind: 'system-prompt' },
    };
  }

  if (role === 'assistant') {
    return {
      id: `af-${index}`,
      role,
      content: normalizeContent(role, message.content, index),
      source: { kind: 'model', provider, model },
    };
  }

  if (role === 'tool') {
    const toolCallId = stringOf(message.toolCallId) || stringOf(message.tool_call_id);
    if (!toolCallId) {
      throw new BridgeRequestError(`messages[${index}]（tool）缺少 toolCallId`);
    }
    return {
      id: `af-${index}`,
      role,
      toolCallId,
      content: normalizeContent(role, message.content, index),
      source: { kind: 'tool', callId: toolCallId },
      ...(message.isError === true ? { isError: true } : {}),
    };
  }

  throw new BridgeRequestError(`messages[${index}] 的 role「${role || '(空)'}」不受支持`);
}

function normalizeContent(role, content, messageIndex) {
  if (content == null) return [];
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    throw new BridgeRequestError(`messages[${messageIndex}] 的 content 必须是字符串或数组`);
  }

  const blocks = [];
  content.forEach((block, blockIndex) => {
    if (typeof block === 'string') {
      blocks.push({ type: 'text', text: block });
      return;
    }
    if (!block || typeof block !== 'object') {
      throw new BridgeRequestError(`messages[${messageIndex}].content[${blockIndex}] 不是对象`);
    }
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: stringOf(block.text) });
      return;
    }
    if (role === 'assistant' && block.type === 'tool-call') {
      blocks.push(normalizeToolCallBlock(block, messageIndex, blockIndex));
      return;
    }
    throw new BridgeRequestError(
      `messages[${messageIndex}].content[${blockIndex}] 的块类型「${stringOf(block.type) || '(空)'}」不受支持`,
    );
  });
  return blocks;
}

function normalizeToolCallBlock(block, messageIndex, blockIndex) {
  const name = stringOf(block.name);
  if (!name) {
    throw new BridgeRequestError(`messages[${messageIndex}].content[${blockIndex}] 的 tool-call 缺少 name`);
  }
  let args;
  if (typeof block.arguments === 'string') {
    args = block.arguments;
  } else if (block.arguments && typeof block.arguments === 'object') {
    args = JSON.stringify(block.arguments);
  } else {
    args = '{}';
  }
  return {
    type: 'tool-call',
    id: stringOf(block.id) || `call-${messageIndex}-${blockIndex}`,
    name,
    arguments: args,
  };
}

function normalizeTools(tools) {
  if (tools == null) return undefined;
  if (!Array.isArray(tools)) throw new BridgeRequestError('tools 必须是数组');

  const normalized = [];
  tools.forEach((tool, index) => {
    if (!tool || typeof tool !== 'object') {
      throw new BridgeRequestError(`tools[${index}] 不是对象`);
    }
    const name = stringOf(tool.name).trim();
    if (!name) throw new BridgeRequestError(`tools[${index}] 缺少 name`);
    normalized.push({
      name,
      description: stringOf(tool.description),
      parameters:
        tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
    });
  });
  return normalized.length ? normalized : undefined;
}

// ---------------------------------------------------------------------------
// IO / 小工具
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  } catch {}
}

function isAuthorized(req, token) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function isLocalHost(host) {
  return typeof host === 'string' && LOCAL_HOST_RE.test(host);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new BodyTooLargeError('body too large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (err) => fail(err);
    const onAborted = () => fail(new Error('请求被中断'));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    try {
      server.listen(port, '127.0.0.1');
    } catch (err) {
      server.off('listening', onListening);
      server.off('error', onError);
      reject(err);
    }
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // keep-alive 的空闲连接会拖住 close，直接收掉
    try {
      server.closeAllConnections?.();
    } catch {}
  });
}

async function writeInfoFile(state) {
  await fs.mkdir(path.dirname(state.infoFile), { recursive: true });
  const payload = JSON.stringify({
    version: 1,
    pid: process.pid,
    port: state.port,
    token: state.token,
    startedAt: state.startedAt,
  });
  // 先写临时文件再 rename，避免调用方读到半个 JSON
  const tmp = `${state.infoFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, payload, { mode: 0o600 });
  try {
    await fs.chmod(tmp, 0o600);
  } catch {}
  await fs.rename(tmp, state.infoFile);
}

async function removeInfoFile(state) {
  try {
    const raw = await fs.readFile(state.infoFile, 'utf8');
    const info = JSON.parse(raw);
    // 只删自己写的那份：多实例/热重载时不误伤别人
    if (info && info.pid === process.pid && info.token === state.token) {
      await fs.unlink(state.infoFile);
    }
  } catch {}
}

function stringOf(value) {
  return typeof value === 'string' ? value : '';
}

function errorMessage(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  const text = String(err);
  return text && text !== '[object Object]' ? text : '未知错误';
}
