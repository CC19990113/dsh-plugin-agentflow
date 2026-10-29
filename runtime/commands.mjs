// commands.mjs —— 斜杠命令的存储层（一条命令 = 一个画布的对话入口）。
//
// 落盘：<DATA_DIR>/commands/<name>.json
//   { version: 1, name: 'agentflow-x', board: '<boardId>', createdAt: <ms> }
//
// 命令名同时是 DSH 的斜杠命令和这里的文件名，所以规则由 DSH 侧决定：
//   ^[a-z][a-z0-9_-]*$，长度 <= 48。
// 本模块只做存储：画布是否存在、节点是否为空这类业务判断在 server.mjs。

import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir, writeJsonAtomic } from './store.mjs';

export const COMMAND_VERSION = 1;
/** 命令名规则：小写字母开头，只允许 a-z 0-9 _ - */
export const COMMAND_NAME_RE = /^[a-z][a-z0-9_-]*$/;
export const COMMAND_NAME_MAX = 48;

/** 命令目录：<DATA_DIR>/commands（dataDir 每次现读 env，测试可切临时目录） */
export function commandsDir() {
  return path.join(dataDir(), 'commands');
}

/** 一条命令的落盘文件；名字必须先过 isValidCommandName（调用方负责） */
export function commandFile(name) {
  return path.join(commandsDir(), `${name}.json`);
}

/** 严格校验：命令名要能直接当文件名、当斜杠命令 */
export function isValidCommandName(name) {
  return (
    typeof name === 'string'
    && name.length > 0
    && name.length <= COMMAND_NAME_MAX
    && COMMAND_NAME_RE.test(name)
  );
}

/** 扫目录拿命令名（只认 *.json，且文件名本身合法） */
async function commandNames() {
  let entries;
  try {
    entries = await fs.readdir(commandsDir());
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .filter(isValidCommandName);
}

/**
 * 读一条命令：不存在 / 半截 JSON / 内容不是对象 都返回 null。
 * @returns {Promise<null | {version: number, name: string, board: string, createdAt: number, file: string}>}
 */
export async function readCommand(name) {
  if (!isValidCommandName(name)) return null;
  let raw;
  try {
    raw = await fs.readFile(commandFile(name), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return {
    version: Number(parsed.version) || COMMAND_VERSION,
    // 文件名是权威：JSON 里的 name 只作展示，不参与定位
    name,
    board: String(parsed.board ?? ''),
    createdAt: Number(parsed.createdAt) || 0,
    file: commandFile(name),
  };
}

/** 全部命令，按创建时间新的在前。 */
export async function listCommands() {
  const out = [];
  for (const name of await commandNames()) {
    const rec = await readCommand(name);
    if (!rec) continue;
    out.push({ name: rec.name, board: rec.board, createdAt: rec.createdAt, file: rec.file });
  }
  out.sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
  return out;
}

/**
 * 把任意字符串压成合法命令名：非法字符转 '-'、首字符非字母补 'b'、截断 48。
 * 纯函数，不做重名处理（重名是 commandNameFor 的事）。
 */
export function normalizeCommandName(desired) {
  const cleaned = String(desired ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-') // 非法字符统一转 '-'
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, COMMAND_NAME_MAX)
    .replace(/[-_]+$/g, '');
  // 首字符必须是字母：数字开头补 'b'（'9x' → 'b9x'，空串 → 'b'）
  const head = /^[a-z]/.test(cleaned) ? cleaned : `b${cleaned}`;
  return head || 'b';
}

/** 画布 id → 可读 slug（'flow-agentflow' → 'agentflow-flow-agentflow'） */
function commandSlug(boardId) {
  return String(boardId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

/**
 * 按画布 id 生成一个不冲突的命令名：'agentflow-<slug>'，重名依次加 '-2'/'-3'…
 * 后缀最多占 3 个字符，所以 base 先截到 45。
 */
export async function commandNameFor(boardId) {
  const slug = commandSlug(boardId);
  const wanted = normalizeCommandName(`agentflow-${slug || 'board'}`);
  const base = wanted.slice(0, COMMAND_NAME_MAX - 3) || 'agentflow';
  let name = base;
  let n = 2;
  while (await readCommand(name)) name = `${base}-${n++}`;
  return name;
}

/**
 * 写一条命令（同名文件直接覆盖）。
 *
 * @param {{board: string, name?: string}} opts
 *   board 必填；name 缺省时按画布 id 生成并自动避开重名。
 * @returns {Promise<{name: string, board: string, file: string, replaced: boolean, createdAt: number}>}
 *   replaced=true 表示覆盖了同名旧命令；同一张画布重复导出时 createdAt 沿用第一次，
 *   换绑到别的画布则算新建（时间刷新）。
 */
export async function writeCommand({ board, name } = {}) {
  const boardId = typeof board === 'string' ? board.trim() : '';
  if (!boardId) throw new Error('writeCommand 需要 board');
  const wanted = typeof name === 'string' ? name.trim() : '';
  // 显式传名字时也归一化：server 已经严格校验过，这里只兜底
  const finalName = wanted ? normalizeCommandName(wanted) : await commandNameFor(boardId);
  const existing = await readCommand(finalName);
  const createdAt =
    existing && existing.board === boardId ? existing.createdAt : Date.now();
  const file = commandFile(finalName);
  await writeJsonAtomic(file, {
    version: COMMAND_VERSION,
    name: finalName,
    board: boardId,
    createdAt,
  });
  return { name: finalName, board: boardId, file, replaced: Boolean(existing), createdAt };
}

/** 删一条命令；返回是否真的删掉了（不存在 / 名字非法都返回 false）。 */
/**
 * 删画布时级联清掉指向它的命令文件。
 *
 * 不清的话：画布没了命令还在（插件侧会跳过不注册），同名 id 再次出现时旧命令
 * 会"复活"；用户也会在命令目录里堆一堆死文件。
 *
 * @param {string} boardId 被删的画布 id
 * @returns {Promise<string[]>} 被删掉的命令名
 */
export async function deleteCommandsForBoard(boardId) {
  const wanted = String(boardId ?? '');
  if (!wanted) return [];
  const removed = [];
  for (const record of await listCommands()) {
    if (record.board !== wanted) continue;
    if (await deleteCommand(record.name)) removed.push(record.name);
  }
  return removed;
}

export async function deleteCommand(name) {
  if (!isValidCommandName(name)) return false;
  const file = commandFile(name);
  const existed = await fs
    .stat(file)
    .then((st) => st.isFile())
    .catch(() => false);
  if (!existed) return false;
  await fs.rm(file, { force: true });
  return true;
}
