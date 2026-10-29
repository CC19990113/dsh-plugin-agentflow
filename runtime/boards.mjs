// boards.mjs —— 多画布存储层（每个自定义预设一张画布）。
//
// 索引：<DATA_DIR>/boards.json
//   结构见 docs/boards-contract.md：{ order: [id...], boards: { id: {id,name,presetId,createdAt,updatedAt} } }
// 画布：<DATA_DIR>/boards/<id>.json，内容就是 Board（id/name/nodes/edges）。
//
// 迁移：boards.json 不存在且 <DATA_DIR>/board.json 存在 → 复制成 flow-agentflow，原文件不动。
// 过渡：flow-agentflow 与旧 board.json 做 mtime 仲裁的兼容 ——
//   旧文件比画布文件新（说明有人在直接写 board.json）时，先导入再读写；
//   一旦发生过这种导入，后续保存会同步镜像回旧文件（否则旧测试/旧前端读不到结果）。
//   迁移后没人动旧文件时，旧文件永远保持原样。

import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir, writeJsonAtomic, exclusive } from './store.mjs';
import { orchestratorPersona, orchestratorCriteria } from './orchestrator.mjs';

export const FLOW_BOARD_ID = 'flow-agentflow';

// id 会拼进文件路径：只允许字母数字开头，禁止 .. 之类
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 带 HTTP 状态码的错误，server.mjs 直接把它翻成响应码。 */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function boardsDir() {
  return path.join(dataDir(), 'boards');
}

export function indexFile() {
  return path.join(dataDir(), 'boards.json');
}

/** 旧单画布文件（迁移来源 / 过渡兼容目标） */
export function legacyBoardFile() {
  return path.join(dataDir(), 'board.json');
}

export function boardFile(id) {
  return path.join(boardsDir(), `${id}.json`);
}

/** 草稿目录：手动保存前的未落定修改，一张画布一份 */
export function draftsDir() {
  return path.join(dataDir(), 'drafts');
}

export function draftFile(id) {
  return path.join(draftsDir(), `${id}.json`);
}

export function isValidBoardId(id) {
  return typeof id === 'string' && ID_RE.test(id) && !id.includes('..');
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function mtimeMs(file) {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return -1;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// ---------- 索引 ----------

function emptyIndex() {
  return { order: [], boards: {} };
}

/** 容错：剔除 order 里不存在的 id、补上 boards 里有但 order 漏了的 id。 */
function normalizeIndex(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const boards = source.boards && typeof source.boards === 'object' ? source.boards : {};
  const seen = new Set();
  const order = [];
  for (const rawId of Array.isArray(source.order) ? source.order : []) {
    const id = String(rawId);
    if (!boards[id] || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  const missing = Object.keys(boards)
    .filter((id) => !seen.has(id))
    .sort((a, b) => (boards[a]?.createdAt || 0) - (boards[b]?.createdAt || 0));
  order.push(...missing);
  return { order, boards };
}

export async function readIndex() {
  return normalizeIndex(await readJson(indexFile()));
}

export async function writeIndex(index) {
  const normalized = normalizeIndex(index);
  await writeJsonAtomic(indexFile(), normalized);
  return normalized;
}

// ---------- 迁移 / 旧文件过渡 ----------

async function readLegacyBoard() {
  return readJson(legacyBoardFile());
}

/** 迁移只跑一次：索引存在就直接返回；原 board.json 一个字节都不改。 */
export async function migrateIfNeeded() {
  return exclusive(async () => {
    if (await exists(indexFile())) return { migrated: false };
    const legacy = await readLegacyBoard();
    if (!legacy) return { migrated: false };

    const now = Date.now();
    const board = {
      ...legacy,
      id: FLOW_BOARD_ID,
      name: legacy.name || 'AgentFlow',
      nodes: Array.isArray(legacy.nodes) ? legacy.nodes : [],
      edges: Array.isArray(legacy.edges) ? legacy.edges : [],
    };
    const meta = {
      id: FLOW_BOARD_ID,
      name: board.name,
      presetId: FLOW_BOARD_ID,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(boardFile(FLOW_BOARD_ID), board);
    await writeJsonAtomic(indexFile(), { order: [FLOW_BOARD_ID], boards: { [FLOW_BOARD_ID]: meta } });
    return { migrated: true, board, meta };
  });
}

// 发生过旧文件导入的 id：之后保存时把内容镜像回旧文件（仅过渡期用）
const legacyActive = new Set();

/**
 * 旧 board.json 比 flow-agentflow 画布文件新时，按旧文件为准导入一次。
 * 只在 exclusive 内部调用，调用方不需要再上锁。
 */
async function importLegacyIfNewerUnlocked(id) {
  if (id !== FLOW_BOARD_ID) return false;
  const legacyMs = await mtimeMs(legacyBoardFile());
  if (legacyMs < 0) return false;
  if ((await mtimeMs(boardFile(id))) >= legacyMs) return false;

  const legacy = await readLegacyBoard();
  if (!legacy) return false;

  const board = {
    ...legacy,
    id,
    name: legacy.name || 'AgentFlow',
    nodes: Array.isArray(legacy.nodes) ? legacy.nodes : [],
    edges: Array.isArray(legacy.edges) ? legacy.edges : [],
  };
  await writeJsonAtomic(boardFile(id), board);

  const index = await readIndex();
  const now = Date.now();
  const meta = index.boards[id] || {
    id,
    name: board.name,
    presetId: FLOW_BOARD_ID,
    createdAt: now,
    updatedAt: now,
  };
  meta.name = board.name;
  meta.updatedAt = now;
  index.boards[id] = meta;
  if (!index.order.includes(id)) index.order.push(id);
  await writeIndex(index);

  legacyActive.add(id);
  return true;
}

// ---------- 画布 ----------

async function readBoardRaw(id) {
  if (!isValidBoardId(id)) return null;
  return readJson(boardFile(id));
}

/** 读一张画布；不存在 / id 非法返回 null。 */
export async function getBoard(id) {
  if (!isValidBoardId(id)) return null;
  return exclusive(async () => {
    await importLegacyIfNewerUnlocked(id);
    return readBoardRaw(id);
  });
}

/** 列表：索引顺序 + 每张的 nodeCount / 是否有草稿。 */
export async function listBoards() {
  const index = await readIndex();
  const withDraft = await draftIdSet();
  const out = [];
  for (const id of index.order) {
    const meta = index.boards[id];
    const board = await readBoardRaw(id);
    out.push({
      id,
      name: board?.name || meta?.name || id,
      presetId: meta?.presetId ?? null,
      nodeCount: Array.isArray(board?.nodes) ? board.nodes.length : 0,
      updatedAt: meta?.updatedAt || meta?.createdAt || 0,
      hasDraft: withDraft.has(id),
      // 改了画布但还没点「保存」（预设没跟着更新）
      presetOutdated: Boolean(meta?.presetOutdated),
    });
  }
  return out;
}

/** 默认画布 = 索引里的第一张。找不到返回 null。 */
export async function resolveBoard(id) {
  const wanted = id ? String(id) : (await readIndex()).order[0];
  if (!wanted) return null;
  const board = await getBoard(wanted);
  return board ? { id: wanted, board } : null;
}

function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'board';
}

/**
 * 新建画布的默认根节点（调度卡 / 对话入口）。
 *
 * 产品约定：画布必须有一张且只有一张调度根节点，它承载人格、是对话入口。
 * 新建时直接给一张，用户不用先手动派生再改类型；子节点仍然由用户自己派生。
 * 根节点在后端删不掉（DELETE 命中 orchestrator 返回 400），所以不会退化成空画布。
 */
function defaultRootNode(name) {
  return {
    id: 'orchestrator',
    label: `${name} · 调度`,
    type: 'orchestrator',
    provider: '',
    model: '',
    reasoningEffort: '',
    fallback: [],
    fallbackEfforts: {},
    task: orchestratorPersona({ name }),
    criteria: orchestratorCriteria(),
    skills: [],
    tools: [],
    verify: '',
    content: '',
    status: 'idle',
    usage: null,
    error: null,
    verdict: null,
    x: 80,
    y: 80,
  };
}

/** 新建画布：presetId 有值就用它当 id（冲突报 409），否则由名字生成唯一 id。 */
export async function createBoard({ name, presetId } = {}) {
  const safeName = String(name || '').trim() || '未命名画布';
  const wantedPreset = presetId === undefined || presetId === null || presetId === ''
    ? null
    : String(presetId);
  if (wantedPreset && !isValidBoardId(wantedPreset)) {
    throw httpError(400, `预设 id 不合法：${wantedPreset}`);
  }

  return exclusive(async () => {
    const index = await readIndex();
    let id;
    if (wantedPreset) {
      if (index.boards[wantedPreset] || (await exists(boardFile(wantedPreset)))) {
        throw httpError(409, `画布已存在：${wantedPreset}`);
      }
      id = wantedPreset;
    } else {
      const base = slugify(safeName);
      id = base;
      let n = 2;
      while (index.boards[id] || (await exists(boardFile(id)))) id = `${base}-${n++}`;
    }

    const now = Date.now();
    // 新建画布默认带一张调度根节点（对话入口），子节点由用户自己派生
    const board = { id, name: safeName, nodes: [defaultRootNode(safeName)], edges: [] };
    const meta = { id, name: safeName, presetId: wantedPreset, createdAt: now, updatedAt: now };
    await writeJsonAtomic(boardFile(id), board);
    await writeIndex({
      order: [...index.order, id],
      boards: { ...index.boards, [id]: meta },
    });
    return { board, meta };
  });
}

/** 持久化一张画布（读-改-写用同一个锁）。opts.clearDraft：正式保存后清草稿。 */
async function persistUnlocked(id, board, opts = {}) {
  const index = await readIndex();
  const now = Date.now();
  const prev = index.boards[id];
  const meta = prev
    ? { ...prev }
    : { id, name: board.name || id, presetId: id === FLOW_BOARD_ID ? FLOW_BOARD_ID : null, createdAt: now, updatedAt: now };

  const next = { ...board, id };
  if (legacyActive.has(id) && id === FLOW_BOARD_ID) {
    // 先写旧文件、后写画布文件：保证画布文件 mtime 更新，不会触发下一次导入
    await writeJsonAtomic(legacyBoardFile(), next);
  }
  await writeJsonAtomic(boardFile(id), next);

  if (next.name) meta.name = next.name;
  meta.updatedAt = now;
  // 画布内容变了，预设就落后了：列表上要能提示「预设未更新」。
  // 导出预设成功后由 markPresetSynced 清掉。
  if (!opts.keepPresetSynced) meta.presetOutdated = true;
  index.boards[id] = meta;
  if (!index.order.includes(id)) index.order.push(id);
  await writeIndex(index);
  // 只有「正式保存」才让草稿失效：节点 patch / 跑图结果也走底层的 mutateBoardById，
  // 那些不该顺手丢掉用户还没保存的草稿。
  if (opts.clearDraft) await removeDraftUnlocked(id);
  return { ok: true, meta, board: next };
}

/** 读-改-写一张画布；画布不存在抛 404。opts.clearDraft 透传给 persistUnlocked。 */
export async function mutateBoardById(id, fn, opts = {}) {
  if (!isValidBoardId(id)) throw httpError(404, `画布不存在：${id}`);
  return exclusive(async () => {
    await importLegacyIfNewerUnlocked(id);
    const index = await readIndex();
    const existing = await readBoardRaw(id);
    if (!existing && !index.boards[id]) throw httpError(404, `画布不存在：${id}`);
    const base = existing || { id, name: index.boards[id]?.name || id, nodes: [], edges: [] };
    const next = await fn(base);
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error('mutateBoardById 的回调必须返回画布对象');
    }
    return persistUnlocked(id, next, opts);
  });
}

/** 整体保存一张画布（PUT /api/boards/:id）：正式保存，成功后草稿失效。 */
export async function saveBoard(id, board) {
  if (!board || typeof board !== 'object' || Array.isArray(board)) {
    throw httpError(400, '缺少画布数据');
  }
  const out = await mutateBoardById(id, () => ({ ...board, id }), { clearDraft: true });
  return { ok: true, meta: out.meta };
}

/** 导出预设成功后调用：画布与预设重新对齐，清掉「预设未更新」。 */
export async function markPresetSynced(id) {
  if (!isValidBoardId(id)) return { ok: false };
  return exclusive(async () => {
    const index = await readIndex();
    const meta = index.boards[id];
    if (meta) {
      meta.presetOutdated = false;
      index.boards[id] = meta;
      await writeIndex(index);
    }
    return { ok: true };
  });
}

/** 改元信息（目前只有 name）。 */
export async function renameBoard(id, name) {
  if (!isValidBoardId(id)) throw httpError(404, `画布不存在：${id}`);
  const safeName = String(name ?? '').trim();
  if (!safeName) throw httpError(400, '画布名不能为空');

  return exclusive(async () => {
    const index = await readIndex();
    const meta = index.boards[id];
    if (!meta) throw httpError(404, `画布不存在：${id}`);
    const board = await readBoardRaw(id);
    if (board) {
      board.name = safeName;
      await writeJsonAtomic(boardFile(id), board);
    }
    meta.name = safeName;
    meta.updatedAt = Date.now();
    index.boards[id] = meta;
    await writeIndex(index);
    return { ok: true, meta };
  });
}

/** 删除画布；最后一张不许删。 */
export async function deleteBoard(id) {
  if (!isValidBoardId(id)) throw httpError(404, `画布不存在：${id}`);
  return exclusive(async () => {
    const index = await readIndex();
    if (!index.boards[id]) throw httpError(404, `画布不存在：${id}`);
    if (index.order.length <= 1) throw httpError(400, '至少要保留一张画布');

    const order = index.order.filter((x) => x !== id);
    const boards = { ...index.boards };
    delete boards[id];
    // 先落索引再删文件：中途崩溃最多留下孤儿文件，不会出现索引指向缺失文件
    await writeIndex({ order, boards });
    await fs.rm(boardFile(id), { force: true });
    await removeDraftUnlocked(id);
    legacyActive.delete(id);
    // 画布没了，指向它的命令也该消失（失败不阻塞删画布）
    try {
      const { deleteCommandsForBoard } = await import('./commands.mjs');
      await deleteCommandsForBoard(id);
    } catch {
      /* 命令清理是附带动作，删画布本身已经成功 */
    }
    return { ok: true, id };
  });
}

// ---------- 草稿（手动保存 + 未保存修改） ----------
//
// 画布定位收窄成「预设工作流配置器」后，编辑不再自动落盘：
// 前端把未保存的修改 PUT 到草稿，正式保存时草稿清掉。
// 文件：<DATA_DIR>/drafts/<id>.json，内容 { board, updatedAt }。

/** 扫目录拿有草稿的画布 id（只看文件名，不读内容）。 */
async function draftIdSet() {
  try {
    const entries = await fs.readdir(draftsDir());
    return new Set(
      entries
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length)),
    );
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

/** 是否有草稿；id 非法按没有处理。 */
export async function hasDraft(id) {
  return isValidBoardId(id) && (await exists(draftFile(id)));
}

/** 读草稿：返回 { board, updatedAt }，没有 / id 非法返回 null。 */
export async function getDraft(id) {
  if (!isValidBoardId(id)) return null;
  const rec = await readJson(draftFile(id));
  if (!rec || typeof rec !== 'object' || !rec.board) return null;
  return { board: rec.board, updatedAt: Number(rec.updatedAt) || 0 };
}

/** 写草稿（原子写）。画布必须存在，否则 404。 */
export async function saveDraft(id, board) {
  if (!isValidBoardId(id)) throw httpError(404, `画布不存在：${id}`);
  if (!board || typeof board !== 'object' || Array.isArray(board)) {
    throw httpError(400, '缺少画布数据');
  }
  return exclusive(async () => {
    const index = await readIndex();
    if (!index.boards[id] && !(await exists(boardFile(id)))) {
      throw httpError(404, `画布不存在：${id}`);
    }
    const updatedAt = Date.now();
    await writeJsonAtomic(draftFile(id), { board: { ...board, id }, updatedAt });
    return { ok: true, updatedAt };
  });
}

/** 无锁删除草稿：只在 exclusive 内部调用（正式保存 / 删画布时顺手清）。 */
async function removeDraftUnlocked(id) {
  if (!isValidBoardId(id)) return false;
  const file = draftFile(id);
  if (!(await exists(file))) return false;
  await fs.rm(file, { force: true });
  return true;
}

/** 删草稿（幂等）。 */
export async function deleteDraft(id) {
  if (!isValidBoardId(id)) throw httpError(404, `画布不存在：${id}`);
  return exclusive(async () => ({ ok: true, removed: await removeDraftUnlocked(id) }));
}

/**
 * 启动时调用：先迁移；一张画布都没有时用 makeBoard() 造默认的 flow-agentflow。
 * @param {() => object} makeBoard 造默认画布内容的函数
 */
export async function ensureDefaultBoard(makeBoard) {
  const migrated = await migrateIfNeeded();
  const index = await readIndex();
  if (index.order.length) {
    return { created: false, migrated: migrated.migrated, id: index.order[0] };
  }

  const seed = typeof makeBoard === 'function' ? makeBoard() : { nodes: [], edges: [] };
  const created = await createBoard({ name: 'AgentFlow', presetId: FLOW_BOARD_ID });
  await saveBoard(FLOW_BOARD_ID, {
    ...seed,
    id: FLOW_BOARD_ID,
    name: created.board.name,
  });
  return { created: true, migrated: migrated.migrated, id: FLOW_BOARD_ID };
}
