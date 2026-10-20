// mcp.mjs —— 零依赖 MCP（Model Context Protocol）客户端 + 连接池
// 规范版本：2024-11-05
//
// 设计要点：
// 1. stdio 传输使用「换行分隔的 JSON-RPC 2.0」；server 混在 stdout 里的非 JSON 日志行跳过。
// 2. 每个请求带超时；超时 / 进程退出 / 关闭都会清理 pending，绝不留下永远不 resolve 的 Promise。
// 3. 子进程 stderr 必须持续消费并保留尾部：不消费的话管道写满会把子进程卡死（经典坑）。
// 4. 连接池按 name 复用健康连接，不重复 spawn；握手失败或进程退出后状态标 ok:false + error。
// 5. 同时支持 stdio 与 streamable-http（JSON 或 SSE 响应），HTTP 会跟随 Mcp-Session-Id。

import { spawn } from 'node:child_process';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = Object.freeze({ name: 'agentflow', version: '0.1.0' });

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const MAX_STDOUT_BUFFER = 8 * 1024 * 1024; // 单行未结束缓冲上限，防内存失控
const MAX_STDERR_BUFFER = 128 * 1024; // 保留 stderr 尾部用于诊断
const STDERR_TAIL_CHARS = 2_000;
const MAX_TOOL_PAGES = 100;

/** 默认日志：只有设置 MCP_DEBUG 时才输出，避免污染宿主程序输出。 */
function defaultLog(text) {
  if (process.env.MCP_DEBUG) {
    try {
      process.stderr.write(`${text}\n`);
    } catch {
      /* 日志失败不影响协议 */
    }
  }
}

function safeLog(log, text) {
  try {
    log(text);
  } catch {
    /* 日志函数自身抛错时忽略 */
  }
}

/** 把任意异常/值转成可读字符串。 */
function describeError(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 把 tools/list 返回的工具整理成稳定结构。 */
function normalizeTool(tool) {
  const t = tool && typeof tool === 'object' ? tool : {};
  return {
    name: typeof t.name === 'string' ? t.name : '',
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema:
      t.inputSchema && typeof t.inputSchema === 'object'
        ? t.inputSchema
        : { type: 'object', properties: {} },
  };
}

/**
 * 把 tools/call 返回的 content 数组拼成文本。
 * text 直接取出；image/audio/resource 等给一个可读占位；未知类型保留 JSON。
 */
function contentToText(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  const parts = [];
  for (const item of content) {
    if (item === null || typeof item !== 'object') {
      parts.push(String(item));
      continue;
    }
    if (item.type === 'text') {
      if (typeof item.text === 'string') parts.push(item.text);
      else if (item.text !== undefined) parts.push(JSON.stringify(item.text));
    } else if (item.type === 'image') {
      parts.push(`[image${item.mimeType ? ` ${item.mimeType}` : ''}]`);
    } else if (item.type === 'audio') {
      parts.push(`[audio${item.mimeType ? ` ${item.mimeType}` : ''}]`);
    } else if (item.type === 'resource') {
      const res = item.resource && typeof item.resource === 'object' ? item.resource : {};
      if (typeof res.text === 'string') parts.push(res.text);
      else if (typeof res.blob === 'string') parts.push(`[resource blob${res.mimeType ? ` ${res.mimeType}` : ''}]`);
      else parts.push(`[resource${res.uri ? ` ${res.uri}` : ''}]`);
    } else if (item.type === 'resource_link') {
      parts.push(`[resource_link${item.uri ? ` ${item.uri}` : ''}]`);
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  return parts.join('\n');
}

/** 解析 SSE 文本，把每个 data 块交给 onMessage。 */
function parseSseText(text, onMessage, log) {
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) continue; // 只有 event:/id:/retry: 的块忽略
    const payload = dataLines.join('\n').trim();
    if (!payload) continue;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      log(`跳过非 JSON 的 SSE data: ${payload.slice(0, 200)}`);
      continue;
    }
    onMessage(msg);
  }
}

/** 连接基类：请求/响应匹配、超时、pending 清理、服务端请求兜底。 */
class BaseConnection {
  constructor(name, spec, cfg) {
    this.name = name;
    this.spec = spec;
    this.cfg = cfg;
    this.kind = 'unknown';
    this.ok = false;
    this.failed = false;
    this.closed = false;
    this.closing = false;
    this.error = null;
    this.tools = [];
    this.serverInfo = null;
    this.protocolVersion = null;
    this.initialized = false;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuf = '';
    this.stderrBuf = '';
  }

  log(text) {
    safeLog(this.cfg.log, `[mcp:${this.name}] ${text}`);
  }

  // 由子类实现
  async start() {}

  // 由子类实现：返回 Promise
  _send() {
    return Promise.reject(new Error(`未实现的 MCP 传输: ${this.kind}`));
  }

  /** 连接当前对外的信息。 */
  info() {
    return {
      name: this.name,
      tools: this.tools.map((t) => ({ ...t })),
      serverInfo: this.serverInfo,
      protocolVersion: this.protocolVersion,
    };
  }

  /** 标记连接失败：状态置错误并 reject 所有 pending。 */
  fail(reason) {
    this.ok = false;
    this.failed = true;
    if (!this.error) this.error = reason;
    this.log(reason);
    this._rejectAll(reason);
  }

  /**
   * 发一个 JSON-RPC 请求，按 id 等响应。
   * 超时会清掉 pending 并 reject；进程退出/关闭时由 _rejectAll 统一 reject。
   */
  async request(method, params, timeoutMs = this.cfg.requestTimeoutMs) {
    if (this.closed) throw new Error(`MCP 连接已关闭: ${this.name}`);
    if (this.failed) {
      throw new Error(
        `MCP server 不可用: ${this.name}${this.error ? ` — ${this.error}` : ''}`,
      );
    }
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.cfg.requestTimeoutMs;
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return; // 已被响应/退出清理
        this.pending.delete(id);
        this.log(`请求超时: ${method} id=${id} (${ms}ms)`);
        const err = new Error(`MCP 请求超时（${ms}ms）: ${this.name} -> ${method}`);
        err.mcpMethod = method;
        err.mcpTimeout = true;
        reject(err);
      }, ms);

      this.pending.set(id, { resolve, reject, timer, method });

      let sent;
      try {
        sent = this._send(msg);
      } catch (err) {
        this._rejectPending(id, `发送 MCP 请求失败: ${this.name} -> ${method}: ${describeError(err)}`);
        return;
      }
      // HTTP 传输的发送过程可能异步失败（网络错误/非 2xx），要连带 reject 这个请求
      Promise.resolve(sent).catch((err) => {
        this._rejectPending(
          id,
          `发送 MCP 请求失败: ${this.name} -> ${method}: ${describeError(err)}`,
        );
      });
    });
  }

  /** 发通知（无 id，不等响应）。 */
  async notify(method, params) {
    if (this.closed) throw new Error(`MCP 连接已关闭: ${this.name}`);
    if (this.failed) {
      throw new Error(`MCP server 不可用: ${this.name}${this.error ? ` — ${this.error}` : ''}`);
    }
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    await this._send(msg);
  }

  /** 列工具，自动跟随 nextCursor 翻页。 */
  async listTools() {
    const tools = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await this.request('tools/list', cursor === undefined ? {} : { cursor });
      if (Array.isArray(result?.tools)) {
        for (const t of result.tools) tools.push(normalizeTool(t));
      }
      const next = typeof result?.nextCursor === 'string' ? result.nextCursor : '';
      if (!next) return tools;
      if (seen.has(next)) {
        this.log(`tools/list 游标重复，停止翻页: ${next}`);
        return tools;
      }
      seen.add(next);
      cursor = next;
    }
    this.log(`tools/list 超过 ${MAX_TOOL_PAGES} 页，停止翻页`);
    return tools;
  }

  /** 处理一条 JSON-RPC 消息（响应、通知、服务端请求）。 */
  _onMessage(msg) {
    if (Array.isArray(msg)) {
      for (const item of msg) this._onMessage(item);
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // 有 method：通知或服务端发起的请求
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) {
        this._handleServerRequest(msg);
      } else {
        this.log(`收到通知: ${msg.method}`);
      }
      return;
    }

    // 响应必须带 id
    if (msg.id === undefined || msg.id === null) {
      this.log('收到既无 id 也无 method 的消息，忽略');
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) {
      // 典型情况：请求已超时，server 的迟到响应；跳过即可
      this.log(`收到未知 id 的响应，忽略: ${String(msg.id)}`);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error && typeof msg.error === 'object') {
      const err = new Error(
        `${this.name}: ${msg.error.message || 'MCP 调用失败'} (code ${msg.error.code})`,
      );
      err.code = msg.error.code;
      err.data = msg.error.data;
      err.mcpMethod = p.method;
      p.reject(err);
      return;
    }
    p.resolve(msg.result ?? {});
  }

  /** server 主动发来的请求：只支持 ping，其余回 -32601，避免 server 干等。 */
  _handleServerRequest(req) {
    if (req.method === 'ping') {
      this._send({ jsonrpc: '2.0', id: req.id, result: {} }).catch((err) => {
        this.log(`回复 ping 失败: ${describeError(err)}`);
      });
      return;
    }
    this.log(`不支持服务端请求 ${req.method}，回 -32601`);
    this._send({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `Method not supported: ${req.method}` },
    }).catch((err) => {
      this.log(`回复服务端请求失败: ${describeError(err)}`);
    });
  }

  /** 处理 stdout 一个文本块：按换行切消息，非 JSON 行跳过。 */
  _onStdoutChunk(chunk) {
    this.stdoutBuf += typeof chunk === 'string' ? chunk : String(chunk);
    let idx;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).replace(/\r$/, '');
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      this._onLine(line);
    }
    if (this.stdoutBuf.length > MAX_STDOUT_BUFFER) {
      this.log(`stdout 单行超过 ${MAX_STDOUT_BUFFER} 字节，丢弃缓冲`);
      this.stdoutBuf = '';
    }
  }

  _onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.log(`跳过非 JSON 日志行: ${trimmed.slice(0, 200)}`);
      return;
    }
    this._onMessage(msg);
  }

  /** 持续消费 stderr，只保留尾部（防管道塞满 + 留诊断信息）。 */
  _onStderrChunk(chunk) {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    this.stderrBuf += text;
    if (this.stderrBuf.length > MAX_STDERR_BUFFER) {
      this.stderrBuf = this.stderrBuf.slice(-MAX_STDERR_BUFFER);
    }
  }

  stderrTail() {
    return this.stderrBuf.trim().slice(-STDERR_TAIL_CHARS);
  }

  _rejectPending(id, reason) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    const err = new Error(reason);
    err.mcpMethod = p.method;
    p.reject(err);
  }

  _rejectAll(reason) {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const p of entries) {
      clearTimeout(p.timer);
      const err = new Error(reason);
      err.mcpMethod = p.method;
      p.reject(err);
    }
  }

  async close() {
    this.closed = true;
    this.ok = false;
    this.failed = true;
  }
}

/** stdio 传输：spawn 子进程，用换行分隔 JSON-RPC。 */
class StdioConnection extends BaseConnection {
  constructor(name, spec, cfg) {
    super(name, spec, cfg);
    this.kind = 'stdio';
    this.child = null;
    this.exitHandled = false;
  }

  async start() {
    const spec = this.spec;
    const command = String(spec.command);
    const args = Array.isArray(spec.args) ? spec.args.map((a) => String(a)) : [];
    const env = {
      ...process.env,
      ...(spec.env && typeof spec.env === 'object' ? spec.env : {}),
    };
    const child = spawn(command, args, {
      env,
      cwd: typeof spec.cwd === 'string' ? spec.cwd : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => this._onStdoutChunk(chunk));
    // 关键：stderr 必须一直读，否则子进程写满管道后会阻塞
    child.stderr?.on('data', (chunk) => this._onStderrChunk(chunk));
    // stdin 的 EPIPE 等错误不处理会变成未捕获异常；这里吞掉，进程退出会另行通知
    child.stdin?.on('error', (err) => {
      this.log(`stdin 错误（进程可能已退出）: ${describeError(err)}`);
    });

    child.on('error', (err) => {
      this._onExit(`MCP server 启动失败: ${describeError(err)}`);
    });
    child.on('exit', (code, signal) => {
      this._onExit(this._exitReason(code, signal));
    });

    // 等 spawn 成功或失败，确保 connect 能立即把启动错误抛给调用方
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        child.off('spawn', done);
        child.off('error', done);
        resolve();
      };
      child.once('spawn', done);
      child.once('error', done);
    });
    if (this.failed) {
      throw new Error(this.error || `MCP server 启动失败: ${this.name}`);
    }
  }

  _exitReason(code, signal) {
    const tail = this.stderrTail();
    return (
      `MCP server 进程退出 (code=${code}, signal=${signal})` +
      (tail ? `，stderr: ${tail}` : '')
    );
  }

  _onExit(reason) {
    if (this.exitHandled) return;
    this.exitHandled = true;
    this.child = null;
    this.ok = false;
    this.failed = true;
    if (this.closing) {
      this.closed = true;
      this._rejectAll(`MCP 连接已关闭: ${this.name}`);
      return;
    }
    this.error = reason;
    this.log(reason);
    this._rejectAll(reason);
  }

  _send(msg) {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new Error(`无法发送 MCP 消息：${this.name} 的子进程未运行`));
    }
    const payload = `${JSON.stringify(msg)}\n`;
    return new Promise((resolve, reject) => {
      child.stdin.write(payload, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close() {
    if (this.closed) return;
    this.closing = true;
    this._rejectAll(`MCP 连接已关闭: ${this.name}`);
    const child = this.child;
    if (!child) {
      this.closed = true;
      this.ok = false;
      this.failed = true;
      return;
    }
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', resolve);
    });
    try {
      child.stdin?.end();
    } catch {
      /* 忽略 */
    }
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出则忽略 */
    }
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }, this.cfg.closeTimeoutMs);
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, this.cfg.closeTimeoutMs + 500)),
    ]);
    clearTimeout(force);
    this.closed = true;
    this.ok = false;
    this.failed = true;
    this.child = null;
  }
}

/** streamable-http 传输：POST JSON-RPC，响应可以是 JSON 或 SSE。 */
class HttpConnection extends BaseConnection {
  constructor(name, spec, cfg) {
    super(name, spec, cfg);
    this.kind = 'http';
    this.url = String(spec.url);
    this.sessionId = null;
  }

  async start() {
    // HTTP 没有本地子进程，握手时自然验证可达性
  }

  _headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.spec.headers && typeof this.spec.headers === 'object') {
      Object.assign(headers, this.spec.headers);
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    // 初始化之后的请求按规范带上协议版本
    if (this.initialized) headers['mcp-protocol-version'] = PROTOCOL_VERSION;
    return headers;
  }

  async _send(msg) {
    if (this.closed) throw new Error(`MCP 连接已关闭: ${this.name}`);
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(this.cfg.requestTimeoutMs + 1000),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return; // 通知的典型响应

    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* 忽略读取失败 */
      }
      throw new Error(
        `MCP HTTP 请求失败 ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
      );
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    const raw = await res.text();
    if (!raw.trim()) return;
    if (contentType.includes('text/event-stream')) {
      parseSseText(raw, (m) => this._onMessage(m), (text) => this.log(text));
      return;
    }
    if (contentType.includes('json')) {
      this._consumeJsonText(raw);
      return;
    }
    // 容忍服务器不设 content-type：按内容猜
    const trimmed = raw.trim();
    if (trimmed.startsWith('data:')) {
      parseSseText(raw, (m) => this._onMessage(m), (text) => this.log(text));
    } else {
      this._consumeJsonText(raw);
    }
  }

  _consumeJsonText(text) {
    try {
      this._onMessage(JSON.parse(text));
      return;
    } catch {
      /* 可能是一行一个 JSON，继续尝试 */
    }
    for (const line of text.split(/\r?\n/)) {
      this._onLine(line);
    }
  }

  async close() {
    if (this.closed) return;
    this.closing = true;
    this._rejectAll(`MCP 连接已关闭: ${this.name}`);
    if (this.sessionId) {
      try {
        const headers = this._headers();
        headers['mcp-session-id'] = this.sessionId;
        await fetch(this.url, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(this.cfg.closeTimeoutMs),
        });
      } catch (err) {
        this.log(`关闭 HTTP 会话失败（忽略）: ${describeError(err)}`);
      }
    }
    this.closed = true;
    this.ok = false;
    this.failed = true;
  }
}

/** 根据 spec 创建连接。 */
function makeConnection(name, spec, cfg) {
  if (!spec || typeof spec !== 'object') {
    throw new Error(`MCP spec 无效: ${name}`);
  }
  const type = spec.type ?? (spec.url ? 'http' : spec.command ? 'stdio' : '');
  if (type === 'http') {
    if (!spec.url) throw new Error(`MCP http spec 缺少 url: ${name}`);
    return new HttpConnection(name, spec, cfg);
  }
  if (type === 'stdio') {
    if (!spec.command) throw new Error(`MCP stdio spec 缺少 command: ${name}`);
    return new StdioConnection(name, spec, cfg);
  }
  throw new Error(`MCP spec 无效（需要 command 或 url）: ${name}`);
}

/**
 * 创建一个 MCP 连接池。
 * @param {object} [opts]
 * @param {number} [opts.requestTimeoutMs=30000] 单请求超时
 * @param {number} [opts.closeTimeoutMs=3000] 关闭时 SIGTERM 到 SIGKILL 的等待
 * @param {(text:string)=>void} [opts.log] 日志回调（默认仅 MCP_DEBUG 时输出）
 */
export function createMcpPool(opts = {}) {
  const cfg = {
    requestTimeoutMs:
      Number.isFinite(opts.requestTimeoutMs) && opts.requestTimeoutMs > 0
        ? opts.requestTimeoutMs
        : DEFAULT_TIMEOUT_MS,
    closeTimeoutMs:
      Number.isFinite(opts.closeTimeoutMs) && opts.closeTimeoutMs > 0
        ? opts.closeTimeoutMs
        : DEFAULT_CLOSE_TIMEOUT_MS,
    log: typeof opts.log === 'function' ? opts.log : defaultLog,
  };

  /** @type {Map<string, BaseConnection>} */
  const connections = new Map();
  /** @type {Map<string, Promise<object>>} 正在连接的 name，避免并发重复 spawn */
  const connecting = new Map();

  /** 握手：initialize → notifications/initialized → tools/list。 */
  async function handshake(conn) {
    const init = await conn.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { ...CLIENT_INFO },
    });
    conn.serverInfo =
      init && typeof init.serverInfo === 'object' ? init.serverInfo : null;
    conn.protocolVersion =
      typeof init?.protocolVersion === 'string' ? init.protocolVersion : PROTOCOL_VERSION;
    conn.initialized = true;
    await conn.notify('notifications/initialized');
    conn.tools = await conn.listTools();
    conn.ok = true;
    conn.error = null;
  }

  /** 连接（或复用）一个 MCP server。 */
  async function connect(name, spec) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('MCP connect 需要非空 name');
    }
    const inflight = connecting.get(name);
    if (inflight) return inflight;

    const existing = connections.get(name);
    if (existing && existing.ok && !existing.closed && !existing.failed) {
      // 健康连接直接复用，绝不重复 spawn
      return existing.info();
    }
    if (existing) {
      // 上一次连接已坏：先收尸再重连
      connections.delete(name);
      await existing.close().catch(() => {});
    }

    const task = (async () => {
      const conn = makeConnection(name, spec, cfg);
      // 先登记：即使启动/握手失败也保留在池里，方便 status() 报告 ok:false + error
      connections.set(name, conn);
      try {
        await conn.start();
      } catch (err) {
        const reason = `MCP 启动失败 (${name}): ${describeError(err)}`;
        conn.fail(reason);
        await conn.close().catch(() => {});
        throw new Error(reason);
      }
      try {
        await handshake(conn);
        safeLog(cfg.log, `[mcp:${name}] 已连接，工具 ${conn.tools.length} 个`);
        return conn.info();
      } catch (err) {
        const reason = `MCP 握手失败 (${name}): ${describeError(err)}`;
        conn.fail(reason);
        await conn.close().catch(() => {});
        throw new Error(reason);
      }
    })();

    connecting.set(name, task);
    try {
      return await task;
    } finally {
      connecting.delete(name);
    }
  }

  /** 已连接（含失败）server 的当前状态。 */
  function status() {
    return [...connections.values()].map((conn) => ({
      name: conn.name,
      ok: Boolean(conn.ok && !conn.failed && !conn.closed),
      error: conn.error,
      tools: conn.tools.map((t) => ({ ...t })),
    }));
  }

  /** 执行工具，返回拼接后的文本。 */
  async function callTool(serverName, toolName, args) {
    const conn = connections.get(serverName);
    if (!conn) {
      throw new Error(`MCP server 未连接: ${serverName}（请先 connect）`);
    }
    if (conn.closed) throw new Error(`MCP 连接已关闭: ${serverName}`);
    if (conn.failed) {
      throw new Error(
        `MCP server 不可用: ${serverName}${conn.error ? ` — ${conn.error}` : ''}`,
      );
    }
    if (typeof toolName !== 'string' || toolName === '') {
      throw new Error('MCP callTool 需要非空 toolName');
    }
    const result = await conn.request('tools/call', {
      name: toolName,
      arguments: args && typeof args === 'object' ? args : {},
    });
    const text = contentToText(result?.content);
    if (result?.isError) {
      const err = new Error(
        `MCP 工具返回错误 ${serverName}/${toolName}: ${text || '（无错误文本）'}`,
      );
      err.mcpToolError = true;
      err.content = result.content;
      throw err;
    }
    if (text) return text;
    if (result?.structuredContent !== undefined) {
      return JSON.stringify(result.structuredContent);
    }
    return '';
  }

  /** 查一个工具的 schema（供 llm.mjs 的 function calling 用）；找不到返回 null。 */
  function toolDef(serverName, toolName) {
    const conn = connections.get(serverName);
    if (!conn || conn.closed) return null;
    const tool = conn.tools.find((t) => t.name === toolName);
    return tool ? { ...tool } : null;
  }

  /** 关闭全部连接（stdio 杀进程；http 发 DELETE 结束会话）。 */
  async function closeAll() {
    // 等正在握手的连接落地，避免漏杀
    const inflight = [...connecting.values()];
    if (inflight.length > 0) {
      await Promise.all(inflight.map((p) => p.catch(() => {})));
    }
    const all = [...connections.values()];
    connections.clear();
    await Promise.all(
      all.map((conn) =>
        conn.close().catch((err) => {
          safeLog(cfg.log, `[mcp:${conn.name}] 关闭失败（忽略）: ${describeError(err)}`);
        }),
      ),
    );
  }

  /** 调试用：拿到 stdio 子进程（测试里用来模拟「进程被杀」）。 */
  function _getChild(serverName) {
    const conn = connections.get(serverName);
    return conn && conn.kind === 'stdio' ? conn.child : null;
  }

  return { connect, status, callTool, toolDef, closeAll, _getChild };
}
