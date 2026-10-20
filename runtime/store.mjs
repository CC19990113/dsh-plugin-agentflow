// store.mjs —— 落盘底层：读 JSON、原子写、把并发写串起来。
//
// 多画布（boards.json + boards/<id>.json）的存取在 boards.mjs；
// 这里同时留着单画布接口（loadBoard/saveBoard/mutateBoard），给 run.mjs 这类旧代码用。
// 不包含业务判断（那些在 server.mjs / boards.mjs）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 数据目录。每次调用都读 env：测试可以在同一进程里切临时目录。 */
export function dataDir() {
  return process.env.AGENTFLOW_DATA_DIR || path.join(ROOT, 'data');
}

// 旧代码直接 import 这个常量；进程启动后地址不变（测试传 env 起子进程，没问题）。
export const DATA_DIR = dataDir();
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 所有写操作排成一队，避免两次请求同时写同一个文件导致半截 JSON。
let writeChain = Promise.resolve();

function enqueue(fn) {
  const run = writeChain.then(fn, fn);
  // 吞掉错误避免链断掉；真正的错误由 run 返回给调用方
  writeChain = run.catch(() => {});
  return run;
}

/** 串行执行一段异步逻辑（boards.mjs 的读-改-写用它）。 */
export function exclusive(fn) {
  return enqueue(fn);
}

async function ensureDirFor(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
}

/** 原子写：先写 .tmp 再 rename，避免进程被杀留下半截文件。 */
async function atomicWrite(file, text, mode) {
  await ensureDirFor(file);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  if (mode) await fs.chmod(tmp, mode);
  await fs.rename(tmp, file);
}

/** 原子写 JSON（boards.mjs 的画布/索引文件共用这一套）。 */
export async function writeJsonAtomic(file, value, mode) {
  await atomicWrite(file, JSON.stringify(value, null, 2), mode);
  return value;
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// ---------- 单画布（旧接口，过渡期保留） ----------

export async function loadBoard() {
  return readJson(BOARD_FILE, null);
}

export async function saveBoard(board) {
  return enqueue(async () => {
    await atomicWrite(BOARD_FILE, JSON.stringify(board, null, 2));
    return board;
  });
}

/** 读-改-写，串行执行，避免并发丢更新。 */
export async function mutateBoard(fn) {
  return enqueue(async () => {
    const board = (await loadBoard()) || { id: 'demo', name: '未命名', nodes: [], edges: [] };
    const next = await fn(board);
    await atomicWrite(BOARD_FILE, JSON.stringify(next, null, 2));
    return next;
  });
}

// ---------- 配置 ----------

export async function loadConfig() {
  return readJson(CONFIG_FILE, null);
}

export async function saveConfig(cfg) {
  return enqueue(async () => {
    // 600：只有本用户可读，key 不外泄
    await atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2), 0o600);
    return cfg;
  });
}

export const files = { BOARD_FILE, CONFIG_FILE };
