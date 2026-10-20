// server.mjs —— HTTP + SSE，零依赖。
//
// 多画布（契约：docs/boards-contract.md）：
//   GET    /api/boards              → 画布列表
//   POST   /api/boards              → 新建画布
//   POST   /api/boards/import-preset→ 从预设生成画布（P1，当前 501）
//   GET    /api/boards/:id          → 读画布
//   PUT    /api/boards/:id          → 存画布（正式保存，顺手清草稿）
//   PATCH  /api/boards/:id          → 改元信息（name）
//   DELETE /api/boards/:id          → 删画布（最后一张不许删）
//   GET/PUT/DELETE /api/boards/:id/draft → 草稿（手动保存前的未落定修改）
//   GET/PUT /api/board              → 旧接口过渡：读写 flow-agentflow
//
// 其余路由：
//   GET    /                  → index.html
//   POST   /api/nodes         → 新建节点（带 from 时自动建边）
//   PATCH  /api/nodes/:id     → 改节点（含 content）
//   DELETE /api/nodes/:id     → 删节点 + 关联边
//   POST   /api/run           → SSE 跑图
//   GET    /api/config        → 配置（模型目录来自 DSH bridge，只读展示）
//   PUT    /api/config        → 存配置
//   GET    /api/models        → DSH 模型目录（透传 bridge 的 ≤10s 缓存）
//   GET    /api/bridge        → bridge 连接状态（前端显示「模型通道」）
//
// 节点/运行类接口用 ?board=<id> 定位画布；不传就用索引里的第一张。

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { runBoard } from './engine.mjs';
import { loadConfig, saveConfig } from './store.mjs';
import {
  FLOW_BOARD_ID,
  listBoards,
  createBoard,
  saveBoard,
  renameBoard,
  deleteBoard,
  resolveBoard,
  markPresetSynced,
  getBoard,
  mutateBoardById,
  ensureDefaultBoard,
  saveDraft,
  getDraft,
  deleteDraft,
  httpError,
} from './boards.mjs';
import { normalizeConfig, makeCaller } from './llm.mjs';
import { listSkills, defaultSkillDirs } from './skills.mjs';
import { askJev, selfVerify } from './verify.mjs';
import {
  readDshSource,
  readDshSkillDirs,
  readDshModelCatalog,
  dshCatalogAgeMs,
} from './dsh-source.mjs';
import { readBridgeInfo, bridgeUnavailableReason, bridgeInfoPath } from './bridge.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// bridge 发现文件在 <BRIDGE_DIR>/data/dsh-bridge.json。
// 插件默认写到 ~/.dsh/agent-flow；本仓库通常就在那里，DSH_HOME 指到别处时跟着走。
const BRIDGE_DIR = process.env.AGENTFLOW_BRIDGE_DIR
  || (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'agent-flow') : ROOT);

/** 静态资源 MIME 映射（不用第三方库） */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || '127.0.0.1';

// ---------- 初始画布 ----------

function demoBoard() {
  const mk = (id, label, model, x, y, task, criteria) => ({
    id, label, type: 'llm', model, fallback: [],
    x, y, task, criteria,
    skills: [], tools: [], verify: '', verdict: null,
    content: '', status: 'idle', usage: null, error: null,
  });
  return {
    id: 'demo',
    name: 'AgentFlow',
    nodes: [
      mk('n1', '大纲', 'deepseek', 60, 150,
        '根据给定的题材，写一个三幕剧的简要大纲，每幕两三句话。',
        '三幕结构清晰，每幕有一个明确转折'),
      mk('n2', '人物版', 'deepseek', 430, 40,
        '基于大纲，塑造主要人物的动机与成长弧线。',
        '主角有明确欲望、阻碍与转变'),
      mk('n3', '对白版', 'deepseek', 430, 300,
        '基于大纲，为关键场景写几句有张力的对白。',
        '对白有潜台词，不要直白解释情绪'),
      mk('n4', '合并', 'deepseek', 800, 170,
        '把两份材料合并成一份完整的三幕剧梗概，约 300 字。',
        '读起来是一个连贯故事，不是拼接'),
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n1', to: 'n3' },
      { from: 'n2', to: 'n4' },
      { from: 'n3', to: 'n4' },
    ],
  };
}

/** 老数据没有 skills/tools 字段，读出来补上默认值，前端不用到处判空 */
function withNodeDefaults(board) {
  board.nodes = (board.nodes || []).map((n) => ({
    skills: [],
    tools: [],
    ...n,
  }));
  board.edges = board.edges || [];
  return board;
}

/**
 * 按画布 id 找当前画布；id 为空时用索引第一张。
 * 找不到抛 404（server 外层 catch 会翻成响应码）。
 */
async function resolveBoardCtx(requested) {
  const resolved = await resolveBoard(requested || null);
  if (!resolved) {
    throw httpError(404, requested ? `画布不存在：${requested}` : '还没有画布');
  }
  return { id: resolved.id, board: withNodeDefaults(resolved.board) };
}

// ---------- 配置：DSH 版 ----------
//
// 模型目录来自 DSH 内核的 llm bridge，MCP 服务器来自 DSH 的 patch；
// 本地 config.json 只保留 mock 开关和 jev 凭据。
// 所以「DSH 里没配的东西，AgentFlow 里也用不了」是设计约束，不是缺陷。
async function buildCfg() {
  const [dsh, catalog] = await Promise.all([readDshSource(), readDshModelCatalog(BRIDGE_DIR)]);
  const local = normalizeConfig(await loadConfig());
  // providers 只供 /api/config 展示：没有 baseURL、没有凭据 —— 模型调用一律走 bridge。
  const providers = {};
  for (const p of catalog.providers) {
    providers[p.id] = {
      label: p.label,
      baseURL: '',
      model: p.models[0]?.id || '',
      hasKey: !p.error && p.models.length > 0,
    };
  }
  return {
    providers,
    catalog,
    bridgeDir: BRIDGE_DIR,
    mock: local.mock,
    mcpServers: dsh.mcpServers,
    skillDirs: dsh.skillDirs,
    jev: local.jev,
    dsh,
  };
}

// 最近一次 health/catalog 失败的原因，成功时清空；/api/bridge 的 lastError 用它。
let lastBridgeError = null;

/**
 * bridge 状态：发现文件在不在、健康检查过不过、目录里读到几个 provider / 模型。
 * 给 /api/bridge 用：前端「模型通道：DSH 内核」那行细字。
 * 只做一次目录读取（healthy 时），不再额外打 DSH。
 */
async function bridgeStatus() {
  const info = await readBridgeInfo(BRIDGE_DIR).catch(() => null);
  const reason = await bridgeUnavailableReason(BRIDGE_DIR).catch(
    (err) => `bridge 健康检查失败：${String((err && err.message) || err)}`,
  );
  let providers = 0;
  let modelCount = 0;
  if (!reason) {
    const catalog = await readDshModelCatalog(BRIDGE_DIR);
    providers = catalog.providers.length;
    // 只在 healthy 时统计模型总数（拿的就是上面这次读取，不额外请求）
    modelCount = catalog.providers.reduce((n, p) => n + (p.models?.length || 0), 0);
    lastBridgeError = catalog.error || null;
  } else {
    lastBridgeError = reason;
  }
  return {
    configured: Boolean(info),
    healthy: !reason,
    reason,
    providers,
    catalogAgeMs: dshCatalogAgeMs(),
    dir: BRIDGE_DIR,
    infoPath: bridgeInfoPath(BRIDGE_DIR),
    version: info ? info.version : null,
    startedAt: info ? info.startedAt : null,
    modelCount,
    lastError: lastBridgeError,
  };
}

// ---------- MCP ----------

// 连接池懒加载：mcp.mjs 可能还没就绪，这时返回明确状态而不是崩掉
let mcpPool = null;

async function ensureMcpPool() {
  if (mcpPool) return mcpPool;
  try {
    const mod = await import('./mcp.mjs');
    mcpPool = mod.createMcpPool();
    return mcpPool;
  } catch (err) {
    return null;
  }
}

/** 给 /api/mcp 用的快照：配置了哪些 server、连没连上、有哪些工具 */
/** 当前可用的全部技能名与全部 MCP 工具名（根节点默认全选） */
async function allSkillsAndTools() {
  let skills = [];
  try {
    const dirs = (await buildCfg()).skillDirs?.length ? (await buildCfg()).skillDirs : defaultSkillDirs();
    const listed = await listSkills(dirs);
    skills = (Array.isArray(listed) ? listed : []).map((x) => x.name);
  } catch {
    skills = [];
  }
  let tools = [];
  try {
    const snap = await mcpSnapshot();
    for (const server of snap.servers || []) {
      for (const tool of server.tools || []) tools.push(`${server.name}.${tool.name}`);
    }
  } catch {
    tools = [];
  }
  return { skills, tools };
}

async function mcpSnapshot() {
  const cfg = await buildCfg();
  const specs = cfg.mcpServers || {};
  const names = Object.keys(specs);
  if (!names.length) return { servers: [] };

  const pool = await ensureMcpPool();
  if (!pool) {
    return {
      servers: names.map((n) => ({ name: n, ok: false, error: 'MCP 模块未就绪', tools: [] })),
    };
  }
  for (const n of names) {
    try {
      await pool.connect(n, specs[n]);
    } catch {
      // 连接失败的状态由 pool.status() 反映，这里不重复报
    }
  }
  return { servers: pool.status() };
}

// ---------- 小工具 ----------

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const nowId = () => 'n' + Math.random().toString(36).slice(2, 8);

// PUT /api/board 只允许改这些字段：拖动不该把物料冲掉
const LAYOUT_FIELDS = ['x', 'y', 'label', 'task', 'criteria', 'model', 'provider', 'reasoningEffort', 'fallback', 'fallbackEfforts', 'type', 'skills', 'tools', 'verify', 'tool', 'args'];

// ---------- 导出 DSH 预设 ----------

// 懒加载：preset-gen.mjs 由另一个任务并行写，文件暂时不存在时不能把服务带崩
let presetGen = null;
async function getPresetGen() {
  if (presetGen) return presetGen;
  presetGen = await import('./preset-gen.mjs');
  return presetGen;
}

/** 给用户照着敲的安装命令。不自动改 profile —— 改 profile 的风险太大，踩过坑。 */
// ---------- 把生成的预设装进 profile ----------

// 预设写到哪个 profile：默认 DSH 桌面版的 desktop，允许用 AGENTFLOW_PROFILE 覆盖
const PRESET_PROFILE = () =>
  path.join(os.homedir(), '.dsh', 'profiles', process.env.AGENTFLOW_PROFILE || 'desktop');

/**
 * 把生成好的 preset bundle 装进 desktop profile。
 * 幂等：已经装过就只更新 link 和文件，不会重复追加 patch 行。
 * 每次动手前都备份 profile 的两个文件 —— 这里踩过「清空 profile」的坑。
 */
function buildInstallHint(dir, slug) {
  const pkg = `dsh-plugin-flow-${slug}`;
  const profile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
  const addDep = `node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dependencies['${pkg}']='link:${dir}';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+String.fromCharCode(10))"`;
  return [
    `cd ${profile}`,
    '# 1. 把插件加进 dependencies（保留原有内容）',
    addDep,
    '# 2. 建符号链接',
    `ln -sfn ${dir} node_modules/${pkg}`,
    '# 3. 追加 patch 行',
    "cat >> cordis.patch.yml <<'YAML'",
    '- insert:',
    `    - id: preset-flow-${slug}`,
    `      name: '${pkg}'`,
    'YAML',
    '# 4. 重启 DSH，新会话的预设列表里会出现它',
  ].join(String.fromCharCode(10));
}
// ---------- 跑图 ----------

let running = false;

async function handleRun(req, res, boardId) {
  if (running) {
    return json(res, 409, { error: '已经有一次运行在进行中，等它结束再来' });
  }

  let payload = {};
  try {
    payload = await readBody(req);
  } catch (err) {
    return json(res, 400, { error: `请求体解析失败：${err.message}` });
  }

  // 先定画布再开 SSE：画布不存在要回普通 JSON 404，不能已经开始推流
  let ctx;
  try {
    ctx = await resolveBoardCtx(boardId);
  } catch (err) {
    return json(res, Number(err && err.status) || 500, { error: String((err && err.message) || err) });
  }

  running = true;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (ev) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  // 心跳，防止中间层掐断
  const heartbeat = setInterval(() => {
    try {
      if (!res.writableEnded) res.write(': ping\n\n');
    } catch {}
  }, 15000);

  // 注意：不能监听 req 的 close —— POST 请求体读完后 req 就会 close，
  // 那是「请求流结束」而不是「客户端断开」。要监听 res。
  let closed = false;
  res.on('close', () => { closed = true; });

  try {
    const board = ctx.board;
    const cfg = await buildCfg();
    // 挂了工具才需要 MCP 连接池；mock 模式不连
    let pool = null;
    if (!cfg.mock) {
      const wanted = new Set();
      for (const n of board.nodes) {
        for (const t of n.tools || []) wanted.add(String(t).split('.')[0]);
        // MCP 节点用的是单数 tool 字段，别漏了它
        if (n.type === 'mcp' && n.tool) wanted.add(String(n.tool).split('.')[0]);
      }
      if (wanted.size) {
        pool = await ensureMcpPool();
        if (pool) {
          for (const name of wanted) {
            const spec = cfg.mcpServers[name];
            if (!spec) continue;
            try {
              await pool.connect(name, spec);
            } catch {
              // 连不上就让这个工具在调用时返回错误，不阻塞整图
            }
          }
        }
      }
    }
    const callLLM = makeCaller({
      bridgeDir: cfg.bridgeDir,
      mock: cfg.mock,
      mcpPool: pool,
      skillDirs: cfg.skillDirs,
    });

    const targets = Array.isArray(payload.targets) && payload.targets.length
      ? payload.targets
      : null;

    // 先把目标节点重置成 idle，界面上才能看到重新开始
    const verdicts = new Map();
    const cleared = { ...board, nodes: board.nodes.map((n) => {
      if (targets && !targets.includes(n.id)) return n;
      return { ...n, status: 'idle', error: null };
    }) };
    send({ type: 'run:start', targets: targets || 'all', mock: cfg.mock });

    const result = await runBoard(cleared, {
      targets: targets || undefined,
      // MCP 节点要它做确定性调用（不经过模型）
      mcpPool: pool,
      callLLM: async (node, prompt) => {
        if (closed) throw new Error('客户端已断开');
        return callLLM(node, prompt);
      },
      // 结果判断：human 挂起等人，self 让模型自评，jev 调 TypeSafe
      verifyNode: async (node, text) => {
        const mode = node.verify;
        if (!mode) return null;
        if (mode === 'human') return { pending: true };
        if (mode === 'self') {
          const v = await selfVerify(callLLM, node, text);
          return { by: 'self', pass: v.pass, reason: v.reason, at: Date.now() };
        }
        if (mode === 'jev') {
          try {
            const v = await askJev({
              apiKey: cfg.jev?.apiKey,
              proxy: cfg.jev?.proxy,
              content: text,
              criteria: node.criteria,
            });
            return {
              by: 'jev',
              pass: v.pass,
              reason: `score=${v.score.toFixed(2)}`,
              at: Date.now(),
            };
          } catch (err) {
            return { by: 'jev', pass: false, reason: String(err.message || err), at: Date.now() };
          }
        }
        return null;
      },
      emit: (ev) => {
        send(ev);
        if (ev.type === 'node:done' && ev.verdict) verdicts.set(ev.id, ev.verdict);
        if (ev.type === 'node:start') {
          mutateBoardById(ctx.id, (b) => {
            const n = b.nodes.find((x) => x.id === ev.id);
            if (n) n.status = 'running';
            return b;
          }).catch(() => {});
        }
      },
    });

    // 把结果写回画布（这是物料落地的地方）
    await mutateBoardById(ctx.id, (b) => {
      for (const n of b.nodes) {
        if (!result.state.has(n.id)) continue;
        const st = result.state.get(n.id);
        if (targets && !targets.includes(n.id) && st === 'blocked') {
          // 不在目标里被当成 blocked 的，别污染原状态
          continue;
        }
        if (st === 'done' || st === 'review') n.status = st;
        else if (st === 'failed') n.status = 'failed';
        else if (st === 'blocked') n.status = 'blocked';

        const c = result.content.get(n.id);
        if ((st === 'done' || st === 'review') && c) n.content = c;
        if (result.usedModel.get(n.id)) {
          n.usage = { model: result.usedModel.get(n.id), ...(result.usage.get(n.id) || {}) };
        }
        if (st === 'failed') n.error = '该节点所有模型都失败';
        if (verdicts.has(n.id)) n.verdict = verdicts.get(n.id);
        else if (st === 'review') n.verdict = null;
      }
      return b;
    });

    // run:end 由引擎在 runBoard 末尾 emit，这里不再重复发
  } catch (err) {
    send({ type: 'run:error', error: String(err && err.message || err) });
  } finally {
    clearInterval(heartbeat);
    running = false;
    if (!res.writableEnded) res.end();
  }
}

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;

  // DSH 的客户端插件在 dsh-app:// 里跑，来调本机 API 属于跨源调用。
  // 只放行本机壳与本机页面，不放 *：导出预设会改写 profile，不能让任意网页触发。
  const origin = String(req.headers.origin || '');
  const originOk = !origin
    || origin.startsWith('dsh-app://')
    || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  if (p.startsWith('/api/')) {
    if (originOk && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    res.setHeader('Access-Control-Max-Age', '600');
    if (method === 'OPTIONS') {
      res.writeHead(originOk ? 204 : 403);
      return res.end();
    }
  }

  try {
    // --- 静态页 ---
    // 优先用 React 版（web/dist，npm run build 的产物）；
    // 没构建过就退回老的单文件 index.html，保证随时能开。
    if (method === 'GET' && !p.startsWith('/api/')) {
      const dist = path.join(ROOT, 'web', 'dist');
      const distIndex = path.join(dist, 'index.html');
      const hasDist = await fs
        .access(distIndex)
        .then(() => true)
        .catch(() => false);

      if (hasDist) {
        // 真实资源文件（/assets/xxx.js 等）
        if (p !== '/' && p !== '/index.html') {
          const target = path.join(dist, decodeURIComponent(p));
          // 防目录穿越：解析后的路径必须还在 dist 里
          if (target.startsWith(dist)) {
            const file = await fs.readFile(target).catch(() => null);
            if (file) {
              const type = MIME[path.extname(target)] || 'application/octet-stream';
              res.writeHead(200, { 'Content-Type': type });
              return res.end(file);
            }
          }
        }
        const html = await fs.readFile(distIndex);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      if (p === '/' || p === '/index.html') {
        const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8').catch(() => null);
        if (html == null) {
          res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<h1>前端还没构建</h1><p>cd web && npm run build</p>');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
    }

    // --- 多画布（契约 docs/boards-contract.md）---
    if (p === '/api/boards' && method === 'GET') {
      return json(res, 200, { boards: await listBoards() });
    }

    if (p === '/api/boards' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const out = await createBoard({ name: body.name, presetId: body.presetId });
      return json(res, 200, { board: out.board, meta: out.meta });
    }

    // 从预设生成单卡片画布：P1 再做（需要 presets.mjs 暴露 persona/plugins，当前没有）
    if (p === '/api/boards/import-preset' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const presetId = body && typeof body.presetId === 'string' ? body.presetId.trim() : '';
      if (!presetId) return json(res, 400, { error: '需要 presetId' });

      const boardsMod = await import('./boards.mjs');
      const { exportPresetSpec } = await import('./presets.mjs');

      // 幂等：已有同 id 画布就直接返回
      const existing = await boardsMod.getBoard(presetId).catch(() => null);
      if (existing) return json(res, 200, { board: existing, reused: true });

      try {
        const spec = await exportPresetSpec(PRESET_PROFILE(), presetId);

        // 技能：本地全部勾上（用户自建预设本来就是全套）
        let skills = [];
        try {
          const skillsMod = await import('./skills.mjs');
          const dirs = (await buildCfg()).skillDirs?.length
            ? (await buildCfg()).skillDirs
            : skillsMod.defaultSkillDirs();
          // listSkills 返回数组，不是 { skills }
          const listed = await skillsMod.listSkills(dirs);
          skills = (Array.isArray(listed) ? listed : []).map((x) => x.name);
        } catch {
          skills = [];
        }

        // MCP 工具：能列出来的全勾（连不上就空着，不阻塞）
        let tools = [];
        try {
          const snap = await mcpSnapshot();
          for (const server of snap.servers || []) {
            for (const tool of server.tools || []) tools.push(`${server.name}.${tool.name}`);
          }
        } catch {
          tools = [];
        }

        // 模型：目录里第一个可用路由的第一个模型
        let provider = '';
        let model = '';
        try {
          const catalog = await readDshModelCatalog(BRIDGE_DIR);
          const first = (catalog.providers || []).find((x) => (x.models || []).length);
          if (first) {
            provider = first.id;
            model = first.models[0].id;
          }
        } catch {
          /* 目录拿不到就留空，节点里再选 */
        }

        const created = await boardsMod.createBoard({ name: spec.name || presetId, presetId });
        const node = {
          id: 'n1',
          label: spec.name || presetId,
          type: 'llm',
          provider,
          model,
          reasoningEffort: '',
          fallback: [],
          fallbackEfforts: {},
          task: spec.persona || spec.description || '',
          criteria: spec.description || '',
          skills,
          tools,
          verify: '',
          content: '',
          status: 'idle',
          usage: null,
          error: null,
          verdict: null,
          x: 80,
          y: 80,
        };
        const board = {
          id: presetId,
          name: spec.name || presetId,
          nodes: [node],
          edges: [],
        };
        await boardsMod.saveBoard(presetId, board);
        return json(res, 200, {
          board,
          meta: (created && created.meta) || null,
          source: spec.source,
          created: true,
          skills: skills.length,
          tools: tools.length,
        });
      } catch (err) {
        return json(res, err && err.status ? err.status : 400, {
          error: String((err && err.message) || err),
        });
      }
    }

    // --- 草稿：手动保存前的未落定修改 ---
    {
      const draftMatch = p.match(/^\/api\/boards\/([^/]+)\/draft$/);
      if (draftMatch) {
        let boardId = '';
        try {
          boardId = decodeURIComponent(draftMatch[1]);
        } catch {
          boardId = '';
        }
        if (method === 'GET') {
          const rec = await getDraft(boardId);
          if (!rec) return json(res, 404, { error: `没有草稿：${boardId}` });
          return json(res, 200, { draft: rec.board, updatedAt: rec.updatedAt });
        }
        if (method === 'PUT') {
          const body = await readBody(req);
          const incoming = body && typeof body.board === 'object' && body.board ? body.board : null;
          if (!incoming) return json(res, 400, { error: '需要 { board }' });
          const out = await saveDraft(boardId, incoming);
          return json(res, 200, { ok: true, updatedAt: out.updatedAt });
        }
        if (method === 'DELETE') {
          await deleteDraft(boardId);
          return json(res, 200, { ok: true });
        }
      }
    }

    {
      const boardMatch = p.match(/^\/api\/boards\/([^/]+)$/);
      if (boardMatch) {
        let boardId = '';
        try {
          boardId = decodeURIComponent(boardMatch[1]);
        } catch {
          boardId = '';
        }
        if (method === 'GET') {
          const ctx = await resolveBoardCtx(boardId);
          return json(res, 200, { board: ctx.board });
        }
        if (method === 'PUT') {
          const body = await readBody(req);
          // 契约允许 { board } 或裸 board
          const incoming = body && typeof body.board === 'object' && body.board ? body.board : body;
          // 根节点保护：自动保存也不能把调度卡弄丢（它是对话入口）
          const before = await getBoard(boardId).catch(() => null);
          const roots = (before?.nodes || []).filter((n) => n.type === 'orchestrator').map((n) => n.id);
          if (roots.length) {
            const incomingIds = new Set((incoming?.nodes || []).map((n) => n.id));
            const lost = roots.filter((id) => !incomingIds.has(id));
            if (lost.length) {
              return json(res, 400, { error: `根节点（调度卡）不能删除：${lost.join(', ')}` });
            }
          }
          try {
            const gen = await import('./preset-gen.mjs');
            gen.assertRootHasNoUpstream(incoming);
          } catch (err) {
            if (err && err.status) return json(res, 400, { error: String(err.message) });
          }
          const out = await saveBoard(boardId, incoming);
          return json(res, 200, { ok: true, meta: out.meta });
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          const name = body && typeof body === 'object' ? (body.name ?? body.board?.name) : undefined;
          const out = await renameBoard(boardId, name);
          return json(res, 200, { ok: true, meta: out.meta });
        }
        if (method === 'DELETE') {
          await deleteBoard(boardId);
          return json(res, 200, { ok: true });
        }
      }
    }

    // --- 旧 /api/board：过渡期只读写 flow-agentflow ---
    if (p === '/api/board' && method === 'GET') {
      const ctx = await resolveBoardCtx(FLOW_BOARD_ID);
      return json(res, 200, ctx.board);
    }

    if (p === '/api/board' && method === 'PUT') {
      const incoming = await readBody(req);
      const out = await mutateBoardById(FLOW_BOARD_ID, (b) => {
        // 只吃布局类字段；content/status/usage 是物料与运行时状态，不接受前端覆盖
        for (const inc of incoming.nodes || []) {
          const n = b.nodes.find((x) => x.id === inc.id);
          if (!n) continue;
          for (const f of LAYOUT_FIELDS) {
            if (inc[f] !== undefined) n[f] = inc[f];
          }
        }
        if (Array.isArray(incoming.edges)) b.edges = incoming.edges;
        if (incoming.name) b.name = incoming.name;
        return b;
      });
      return json(res, 200, out.board);
    }

    // --- 节点（?board=<id> 定位画布，缺省第一张）---
    if (p === '/api/nodes' && method === 'POST') {
      const ctx = await resolveBoardCtx(url.searchParams.get('board'));
      const body = await readBody(req);
      const node = {
        id: nowId(),
        label: body.label || '新节点',
        type: body.type || 'llm',
        model: body.model || '',
        provider: body.provider || '',
        reasoningEffort: body.reasoningEffort || '',
        fallbackEfforts: body.fallbackEfforts && typeof body.fallbackEfforts === 'object' ? body.fallbackEfforts : {},
        fallback: body.fallback || [],
        x: Number(body.x) || 0,
        y: Number(body.y) || 0,
        task: body.task || '',
        criteria: body.criteria || '',
        skills: Array.isArray(body.skills) ? body.skills : [],
        tools: Array.isArray(body.tools) ? body.tools : [],
        // MCP 节点用这两个字段（单数 tool = server.tool，args 是参数模板）
        tool: body.tool || '',
        args: body.args && typeof body.args === 'object' ? body.args : {},
        verify: body.verify || '',
        verdict: null,
        content: '',
        status: 'idle',
        usage: null,
        error: null,
      };
      const out = await mutateBoardById(ctx.id, (b) => {
        b.nodes.push(node);
        // from：新节点是下游（from → new）；to：新节点是上游（new → to）
        if (body.from) b.edges.push({ from: String(body.from), to: node.id });
        if (body.to) b.edges.push({ from: node.id, to: String(body.to) });
        return b;
      });
      return json(res, 200, { node, board: out.board });
    }

    const nodeMatch = p.match(/^\/api\/nodes\/([^/]+)$/);
    if (nodeMatch && method === 'PATCH') {
      const ctx = await resolveBoardCtx(url.searchParams.get('board'));
      const id = decodeURIComponent(nodeMatch[1]);
      const patch = await readBody(req);
      // 根节点的类型是固定的（对话入口），不允许改
      const currentBoard = await getBoard(ctx.id).catch(() => null);
      const current = (currentBoard?.nodes || []).find((n) => n.id === id);
      if (current && current.type === 'orchestrator' && patch.type !== undefined && patch.type !== 'orchestrator') {
        return json(res, 400, { error: '根节点（调度卡）的类型固定为「调度（根）」，不能修改' });
      }
      let found = null;
      await mutateBoardById(ctx.id, (b) => {
        const n = b.nodes.find((x) => x.id === id);
        if (!n) return b;
        found = n;
        for (const k of ['label', 'task', 'criteria', 'model', 'provider', 'reasoningEffort', 'fallback', 'fallbackEfforts', 'content', 'x', 'y', 'skills', 'tools', 'verify', 'tool', 'args', 'type']) {
          if (patch[k] !== undefined) n[k] = patch[k];
        }
        return b;
      });
      if (!found) return json(res, 404, { error: '节点不存在' });
      return json(res, 200, found);
    }

    if (nodeMatch && method === 'DELETE') {
      const ctx = await resolveBoardCtx(url.searchParams.get('board'));
      const id = decodeURIComponent(nodeMatch[1]);
      const guard = await getBoard(ctx.id).catch(() => null);
      const target = (guard?.nodes || []).find((n) => n.id === id);
      if (target && target.type === 'orchestrator') {
        return json(res, 400, { error: '根节点（调度卡）是对话入口，不能删除' });
      }
      const out = await mutateBoardById(ctx.id, (b) => {
        b.nodes = b.nodes.filter((n) => n.id !== id);
        b.edges = b.edges.filter((e) => e.from !== id && e.to !== id);
        return b;
      });
      return json(res, 200, out.board);
    }

    // --- 人工确认：处理 review 状态的节点 ---
    const verifyMatch = p.match(/^\/api\/verify\/([^/]+)$/);
    if (verifyMatch && method === 'POST') {
      const ctx = await resolveBoardCtx(url.searchParams.get('board'));
      const id = decodeURIComponent(verifyMatch[1]);
      const body = await readBody(req);
      const pass = Boolean(body.pass);
      let found = null;
      await mutateBoardById(ctx.id, (b) => {
        const n = b.nodes.find((x) => x.id === id);
        if (!n) return b;
        found = n;
        n.verdict = {
          by: 'human',
          pass,
          reason: body.reason || (pass ? '人工通过' : '人工打回'),
          at: Date.now(),
        };
        // 通过 → 正常完成；打回 → 回到 idle，内容保留，人可以改了再重跑
        n.status = pass ? 'done' : 'idle';
        return b;
      });
      if (!found) return json(res, 404, { error: '节点不存在' });
      return json(res, 200, found);
    }

    // --- 插件加载打卡（诊断用）---
    if (p === '/api/plugin-alive') {
      const stage = (url.searchParams.get('stage') || '?');
      const detail = url.searchParams.get('detail') || '';
      console.log(`[client-plugin] 打卡: ${stage} @ ${new Date().toISOString()}`);
      try {
        await fs.appendFile('/tmp/agentflow-plugin-alive.log', `${new Date().toISOString()} ${stage}${detail ? ' :: ' + detail : ''}\n`);
      } catch {}
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }

    // --- 用量预估（只算 token，不算钱）---
    if (p === '/api/estimate' && method === 'GET') {
      const ctx = await resolveBoardCtx(url.searchParams.get('board'));
      try {
        const { estimateTokens } = await import('./engine.mjs');
        return json(res, 200, estimateTokens(ctx.board));
      } catch {
        return json(res, 200, { total: 0, perNode: {} });
      }
    }

    // --- 导出 DSH 预设：直接写进插件包，不再生成独立包 ---
    if (p === '/api/export/preset' && method === 'POST') {
      const ctx = await resolveBoardCtx(url.searchParams.get('board'));
      const profileDir = PRESET_PROFILE();
      const profileOk = await fs
        .stat(profileDir)
        .then((st) => st.isDirectory())
        .catch(() => false);
      if (!profileOk) {
        return json(res, 400, {
          error: `找不到 profile：${profileDir}（可用 AGENTFLOW_PROFILE 指定 profile 名）`,
        });
      }
      const board = ctx.board;
      const body = await readBody(req).catch(() => ({}));
      // 自定义预设显示名（可选）：只影响预设名，presetId 仍由画布决定
      const presetName = body && typeof body.name === 'string' ? body.name.trim() : '';
      if (!board.nodes || board.nodes.length === 0) {
        return json(res, 400, { error: '画布是空的，先摆几个节点' });
      }
      let gen;
      try {
        gen = await getPresetGen();
      } catch {
        return json(res, 500, { error: '预设生成器还没就绪（preset-gen.mjs 缺失）' });
      }

      // 调度根节点 = 对话入口 = persona 来源。导出前先补齐：
      // 多节点无调度卡时自动补一张并写回画布；已有只允许一张，多了直接拒绝。
      let ensured;
      try {
        const { skills, tools } = await allSkillsAndTools();
        ensured = gen.ensureOrchestrator(board, { skills, tools });
        gen.assertRootHasNoUpstream(ensured.board);
      } catch (err) {
        return json(res, 400, { error: String((err && err.message) || err) });
      }
      const exportBoard = ensured.board;
      const addedOrchestrator = ensured.added
        ? { id: ensured.added.id, label: ensured.added.label }
        : null;
      const personaSource = gen.personaSource(board);
      if (addedOrchestrator || ensured.refreshed) {
        // 先写回画布再生成：根节点的人格/技能是固定模板，刷新后页面能看到最新内容
        await saveBoard(ctx.id, exportBoard);
      }

      try {
        const out = await gen.installPresetIntoProfile(exportBoard, {
          patchFile: path.join(PRESET_PROFILE(), 'cordis.patch.yml'),
          ...(presetName ? { name: presetName } : {}),
        });
        await markPresetSynced(ctx.id).catch(() => {});
        return json(res, 200, {
          ok: true,
          profileDir: PRESET_PROFILE(),
          file: out.file,
          presetId: out.presetId,
          presetName: out.name,
          replaced: out.replaced,
          personaPreview: gen.renderPersona(exportBoard),
          addedOrchestrator,
          personaSource,
          needRestart: true,
        });
      } catch (err) {
        return json(res, 400, { error: String((err && err.message) || err) });
      }
    }

    // --- 自定义预设列表 / 复制 / 删除（设置页「AgentFlow」分区用）---
    if (p === '/api/presets' && method === 'GET') {
      try {
        const { listPresets } = await import('./presets.mjs');
        const presets = await listPresets(PRESET_PROFILE());
        return json(res, 200, { presets });
      } catch (err) {
        return json(res, 500, { error: String((err && err.message) || err) });
      }
    }

    {
      const presetMatch = /^\/api\/presets\/([^/]+)(\/copy)?$/.exec(p);
      if (presetMatch) {
        const presetId = decodeURIComponent(presetMatch[1]);
        const isCopy = Boolean(presetMatch[2]);
        if (isCopy && method === 'POST') {
          const body = await readBody(req).catch(() => ({}));
          try {
            const { copyPreset } = await import('./presets.mjs');
            const out = await copyPreset(PRESET_PROFILE(), presetId, { name: body && body.name });
            return json(res, 200, { ok: true, ...out, needRestart: true });
          } catch (err) {
            return json(res, 400, { error: String((err && err.message) || err) });
          }
        }
        if (!isCopy && method === 'DELETE') {
          try {
            const { deletePreset } = await import('./presets.mjs');
            const out = await deletePreset(PRESET_PROFILE(), presetId);
            return json(res, 200, { ok: true, ...out, needRestart: true });
          } catch (err) {
            return json(res, err && err.status ? err.status : 400, {
              error: String((err && err.message) || err),
            });
          }
        }
      }
    }

    // --- 跑图 ---
    if (p === '/api/run' && method === 'POST') {
      return handleRun(req, res, url.searchParams.get('board'));
    }

    // --- 技能列表 ---
    if (p === '/api/skills' && method === 'GET') {
      const cfg = await buildCfg();
      const dirs = cfg.skillDirs.length ? cfg.skillDirs : defaultSkillDirs();
      const skills = await listSkills(dirs).catch(() => []);
      return json(res, 200, { dirs, skills });
    }

    // --- MCP 服务器与工具列表 ---
    if (p === '/api/mcp' && method === 'GET') {
      return json(res, 200, await mcpSnapshot());
    }

    // --- 模型目录（只走 bridge；缓存由 bridge 侧承担，这里不再加一层） ---
    if (p === '/api/models' && method === 'GET') {
      return json(res, 200, await readDshModelCatalog(BRIDGE_DIR));
    }

    // --- bridge 连接状态（前端「模型通道」那行细字） ---
    if (p === '/api/bridge' && method === 'GET') {
      return json(res, 200, await bridgeStatus());
    }

    // --- 配置 ---
    if (p === '/api/config' && method === 'GET') {
      const cfg = await buildCfg();
      const providers = {};
      for (const [name, v] of Object.entries(cfg.providers)) {
        providers[name] = {
          label: v.label || name,
          baseURL: v.baseURL || '',
          model: v.model || '',
          hasKey: Boolean(v.hasKey),
        };
      }
      const mcpServers = Object.keys(cfg.mcpServers || {}).map((name) => ({
        name,
        kind: cfg.mcpServers[name].url ? 'http' : 'stdio',
      }));
      return json(res, 200, {
        source: 'dsh',
        readOnly: true,
        mock: cfg.mock,
        providers,
        mcpServers,
        skillDirs: cfg.skillDirs,
        dshPaths: cfg.dsh?.paths || {},
      });
    }

    if (p === '/api/config' && method === 'PUT') {
      const body = await readBody(req);
      const current = await loadConfig();
      const cfg = normalizeConfig(current);
      // DSH 版：模型与 MCP 由 DSH 配置决定，这里只保存 mock 开关和 jev 凭据
      const next = {
        mock: body.mock !== undefined ? Boolean(body.mock) : cfg.mock,
        jev: { ...(cfg.jev || {}) },
      };
      // Jev（TypeSafe）配置：apiKey / proxy 都由前端写，传 null 表示删掉
      if (body.jev && typeof body.jev === 'object') {
        for (const [k, v] of Object.entries(body.jev)) {
          if (v === null) delete next.jev[k];
          else next.jev[k] = v;
        }
      }
      await saveConfig(next);
      return json(res, 200, { ok: true, mock: next.mock });
    }

    return json(res, 404, { error: `没有这个路由：${method} ${p}` });
  } catch (err) {
    // httpError 带 status（404/400/409…），其余按 500 处理
    const status = Number(err && err.status) || 500;
    if (!res.headersSent) {
      json(res, status, { error: String(err && err.message || err) });
    } else {
      res.end();
    }
  }
});

// ---------- 启动 ----------
// 先把画布目录准备好（迁移 / 首次建默认画布），再开始监听：
// 否则就绪检查通过后立刻来的请求可能看到空索引。
const boot = await ensureDefaultBoard(demoBoard);
const bootBoards = await listBoards();
const bootCurrent = await resolveBoard(null);

server.listen(PORT, HOST, async () => {
  console.log(`AgentFlow 已启动  http://${HOST}:${PORT}`);
  const cur = bootCurrent?.board;
  console.log(
    cur
      ? `画布：${bootBoards.length} 张（当前「${cur.name}」，${cur.nodes.length} 节点 / ${cur.edges.length} 连线）`
      : `画布：${bootBoards.length} 张`,
  );
  if (boot.migrated) console.log('已从旧 data/board.json 迁移出 flow-agentflow（原文件保留）');
  const cfg = await buildCfg();
  console.log(`模式：${cfg.mock ? 'mock（不调真模型）' : '真实调用（模型通道：DSH 内核）'}`);
});
