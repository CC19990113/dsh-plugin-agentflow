// bridge.mjs —— AgentFlow 与 DSH 内核里 llm bridge 的通信层。
//
// 契约见 docs/bridge-contract.md。要点：
//   - 不保留直连退路：bridge 连不上就是「DSH 内核未连接」，调用方必须失败
//   - 发现文件由插件写、我们只读；按 mtime 缓存 2 秒
//   - 流事件只有 delta / tool / usage / done / error 五种

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DEFAULT_DIR = path.join(DSH_HOME, 'agent-flow');

const INFO_TTL_MS = 2000;
const HEALTH_TIMEOUT_MS = 300;
const CATALOG_TIMEOUT_MS = 3000;

/** 发现文件位置：<agentflowDir>/data/dsh-bridge.json */
export function bridgeInfoPath(dir = DEFAULT_DIR) {
  return path.join(dir, 'data', 'dsh-bridge.json');
}

let infoCache = { key: '', mtimeMs: 0, at: 0, info: null };

/**
 * 读发现文件。失效的情况全部返回 null，由 bridgeUnavailableReason 给原因。
 * @returns {Promise<{version:number,pid:number,port:number,token:string,startedAt:number}|null>}
 */
export async function readBridgeInfo(dir = DEFAULT_DIR) {
  const file = bridgeInfoPath(dir);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    infoCache = { key: file, mtimeMs: 0, at: Date.now(), info: null };
    return null;
  }
  const key = file;
  const now = Date.now();
  if (infoCache.info && infoCache.key === key && infoCache.mtimeMs === stat.mtimeMs && now - infoCache.at < INFO_TTL_MS) {
    return infoCache.info;
  }
  let info = null;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Number.isInteger(parsed.pid) && Number.isInteger(parsed.port) && typeof parsed.token === 'string' && parsed.token) {
      info = {
        version: Number(parsed.version) || 1,
        pid: parsed.pid,
        port: parsed.port,
        token: parsed.token,
        startedAt: Number(parsed.startedAt) || 0,
      };
    }
  } catch {
    info = null;
  }
  infoCache = { key, mtimeMs: stat.mtimeMs, at: now, info };
  return info;
}

/** 进程是否活着；EPERM 也算活着（存在但没权限发信号） */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function urlOf(info, suffix) {
  return `http://127.0.0.1:${info.port}${suffix}`;
}

function authHeaders(info) {
  return { authorization: `Bearer ${info.token}`, accept: 'application/json' };
}

/**
 * bridge 不可用的原因；可用时返回 null。
 * 文案直接给用户看，必须说清楚是哪一环断了。
 */
export async function bridgeUnavailableReason(dir = DEFAULT_DIR) {
  const info = await readBridgeInfo(dir);
  if (!info) return 'bridge 发现文件不存在（DSH 未运行或插件未加载）';
  if (!pidAlive(info.pid)) return `bridge 进程已退出（pid ${info.pid}）`;
  try {
    const res = await fetch(urlOf(info, '/health'), {
      headers: authHeaders(info),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (res.status === 401) return 'bridge token 校验失败（401）';
    if (!res.ok) return `bridge 健康检查返回 HTTP ${res.status}`;
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true) return 'bridge 健康检查返回异常内容';
    return null;
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/timeout|aborted/i.test(msg)) return `bridge 健康检查超时（${HEALTH_TIMEOUT_MS}ms）`;
    return `bridge 健康检查失败：${msg}`;
  }
}

/** 健康检查；不可用时抛错（由调用方决定怎么展示） */
export async function bridgeHealth(dir = DEFAULT_DIR) {
  const reason = await bridgeUnavailableReason(dir);
  if (reason) throw new Error(reason);
  const info = await readBridgeInfo(dir);
  const res = await fetch(urlOf(info, '/health'), {
    headers: authHeaders(info),
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  return res.json();
}

/** 读模型目录；失败抛错（错误信息含原因） */
export async function bridgeCatalog(dir = DEFAULT_DIR) {
  const info = await readBridgeInfo(dir);
  if (!info) throw new Error('bridge 发现文件不存在（DSH 未运行或插件未加载）');
  if (!pidAlive(info.pid)) throw new Error(`bridge 进程已退出（pid ${info.pid}）`);
  let res;
  try {
    res = await fetch(urlOf(info, '/catalog'), {
      headers: authHeaders(info),
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`bridge /catalog 请求失败：${String((err && err.message) || err)}`);
  }
  if (res.status === 401) throw new Error('bridge token 校验失败（401）');
  if (!res.ok) throw new Error(`bridge /catalog 返回 HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body || !Array.isArray(body.providers)) throw new Error('bridge /catalog 返回结构不对');
  return body;
}

/**
 * 发起一次流式模型调用。
 * @param {object} request 见契约：provider/model/reasoningEffort/system/messages/tools
 * @param {{dir?:string, signal?:AbortSignal}} [opts]
 * @returns {Promise<{events: AsyncIterable<object>, abort: () => void}>}
 */
export async function bridgeStream(request, opts = {}) {
  const dir = opts.dir || DEFAULT_DIR;
  const info = await readBridgeInfo(dir);
  if (!info) throw new Error('DSH 内核未连接（bridge 发现文件不存在）');
  if (!pidAlive(info.pid)) throw new Error(`DSH 内核未连接（bridge 进程已退出，pid ${info.pid}）`);

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(urlOf(info, '/stream'), {
      method: 'POST',
      headers: { ...authHeaders(info), 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (err) {
    if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
    throw new Error(`DSH 内核未连接（bridge /stream 请求失败：${String((err && err.message) || err)}）`);
  }

  if (res.status === 401) throw new Error('DSH 内核未连接（bridge token 校验失败）');
  if (res.status === 429) throw new Error('bridge 忙（并发超限）');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bridge /stream 返回 HTTP ${res.status}${text ? '：' + text.slice(0, 200) : ''}`);
  }
  if (!res.body) throw new Error('bridge /stream 没有响应体');

  return {
    events: readSseEvents(res.body),
    abort: () => controller.abort(),
  };
}

/**
 * 把 SSE 字节流解析成事件对象。只认 `data: ` 行；注释行（`: ping`）忽略。
 * 结束时若没收到 done/error，抛错，避免调用方把截断当成功。
 */
async function* readSseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue; // 坏行跳过，别把整次调用打断
        }
        if (evt && evt.type === 'error') {
          finished = true;
          throw new Error(String(evt.message || 'bridge 调用失败'));
        }
        if (evt && evt.type === 'done') finished = true;
        yield evt;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    if (!finished) throw new Error('bridge 流提前结束（没有收到 done/error）');
  }
}
