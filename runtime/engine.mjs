// engine.mjs —— 纯 DAG 执行器，不碰 IO。
//
// 语义（已与用户确认）：
//   1. 节点在「所有前驱都到达」后执行。失败也是「到达」，只是带错误标记。
//   2. 节点自身失败 → 依次试 fallback 模型 → 全挂则标记 failed，不阻塞其他泳道。
//   3. 前驱 failed/blocked → 本节点 blocked（直接报错，不走）。
//   4. 全图跑完（所有节点进入终态）才结束。
//
// 节点类型：
//   - 'llm'（或不写）：走 callLLM，支持 fallback。
//   - 'mcp'：确定性执行，直接调 opts.mcpPool.callTool，不经过模型、没有 fallback。
//
// 这里只管调度；调用模型 / MCP、发事件、落盘都由调用方注入。

/** 建图索引 */
export function buildIndex(board) {
  const nodes = new Map(board.nodes.map((n) => [n.id, n]));
  const preds = new Map(board.nodes.map((n) => [n.id, []]));
  const succs = new Map(board.nodes.map((n) => [n.id, []]));
  for (const e of board.edges || []) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    preds.get(e.to).push(e.from);
    succs.get(e.from).push(e.to);
  }
  return { nodes, preds, succs };
}

/** 从 root 出发能到达的所有节点（含 root） */
export function reachableFrom(board, rootId) {
  const { nodes, succs } = buildIndex(board);
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || !nodes.has(id)) continue;
    seen.add(id);
    for (const s of succs.get(id)) stack.push(s);
  }
  return seen;
}

/**
 * 上游物料正文：多份时带【id】标签，空物料过滤。
 * composePrompt（llm 节点）和 mcp 节点的 input 共用这一份「素材收集逻辑」。
 */
function collectMaterials(predIds, getContent) {
  const materials = predIds
    .map((p) => ({ id: p, text: (getContent(p) || '').trim() }))
    .filter((m) => m.text);
  return materials
    .map((m) => (materials.length > 1 ? `【${m.id}】\n${m.text}` : m.text))
    .join('\n\n');
}

/** 'server.tool' → { server, tool }，按第一个点切；不合法返回 null */
function splitToolName(full) {
  const text = String(full ?? '').trim();
  const dot = text.indexOf('.');
  if (dot <= 0 || dot === text.length - 1) return null;
  return { server: text.slice(0, dot), tool: text.slice(dot + 1) };
}

/**
 * 渲染 MCP 节点的 args 模板：
 *   {{input}}          → 上游物料拼接结果
 *   {{from.<nodeId>}}  → 指定节点的内容（只知道画布上存在的 id）
 *   其它 {{...}}       → 原样保留
 * 只替换字符串值；对象/数组递归。
 */
function renderArgs(value, ctx) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (raw, name) => {
      const key = name.trim();
      if (key === 'input') return ctx.input;
      if (key.startsWith('from.')) {
        const id = key.slice('from.'.length).trim();
        if (ctx.knownIds.has(id)) return ctx.getContent(id) || '';
      }
      return raw;
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderArgs(item, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = renderArgs(val, ctx);
    return out;
  }
  return value;
}

/**
 * 跑一批节点。
 * @param {object} board  {nodes:[{id,type,model,fallback,task,input,criteria,...}], edges:[{from,to}]}
 * @param {object} opts
 *   - targets: 要跑的节点 id 数组；省略 = 全图
 *   - callLLM: async (node, prompt, ctx) => {content, model, usage}
 *   - mcpPool: 可选，提供 callTool(server, tool, args)（MCP 节点用；llm 节点里由 caller 自己用）
 *   - emit:    (event) => void   事件：node:start/delta/done/failed/blocked, run:end
 *   - getContent: (id) => string  取上游物料（默认读 node.content）
 *   - dry:     只算调度不发请求（给「跑之前先看看」用）
 */
export async function runBoard(board, opts = {}) {
  const { callLLM, emit = () => {}, dry = false } = opts;
  const { nodes, preds } = buildIndex(board);

  const targets = opts.targets && opts.targets.length
    ? new Set(opts.targets.map(String))
    : new Set(nodes.keys());

  const state = new Map();   // id -> pending|running|done|failed|blocked
  const content = new Map(); // id -> 物料文本
  const usedModel = new Map();
  const usage = new Map();

  for (const id of nodes.keys()) {
    state.set(id, 'pending');
    content.set(id, nodes.get(id).content || '');
  }
  // 不在目标集合里的节点：视为已完成（用已有物料），不再执行
  for (const id of nodes.keys()) {
    if (!targets.has(id)) {
      state.set(id, content.get(id) ? 'done' : 'blocked');
    }
  }

  const getContent = opts.getContent || ((id) => content.get(id) || '');

  const terminal = (s) =>
    s === 'done' || s === 'failed' || s === 'blocked' || s === 'review';

  let guard = 0;
  while (true) {
    if (++guard > 10000) throw new Error('调度循环失控，疑似成环');

    const ready = [];
    let justBlocked = 0;

    for (const [id, st] of state) {
      if (st !== 'pending') continue;
      const ps = preds.get(id) || [];
      // 还有前驱没到终态：先不动它，等下一轮
      if (ps.some((p) => !terminal(state.get(p)))) continue;
      // 前驱都到齐了，但其中有失败/阻塞 → 本节点阻塞
      if (ps.some((p) => state.get(p) === 'failed' || state.get(p) === 'blocked')) {
        state.set(id, 'blocked');
        emit({ type: 'node:blocked', id, reason: 'upstream-failed' });
        justBlocked++;
        continue;
      }
      ready.push(id);
    }

    if (ready.length) {
      await Promise.all(
        ready.map(async (id) => {
          const node = nodes.get(id);
          state.set(id, 'running');
          emit({ type: 'node:start', id });
          if (dry) {
            state.set(id, 'done');
            emit({ type: 'node:done', id, dry: true });
            return;
          }

          // ---- MCP 节点：确定性执行，不调模型、没有 fallback ----
          if (node.type === 'mcp') {
            const t0 = Date.now();
            try {
              if (!opts.mcpPool) throw new Error('没有可用的 MCP 连接池');
              const parsed = splitToolName(node.tool);
              if (!parsed) {
                throw new Error(`MCP 节点的 tool 必须是 server.tool 形式：${String(node.tool ?? '（空）')}`);
              }
              const input = collectMaterials(preds.get(id) || [], getContent);
              const args = renderArgs(node.args && typeof node.args === 'object' ? node.args : {}, {
                input,
                getContent,
                knownIds: new Set(nodes.keys()),
              });
              const text = await opts.mcpPool.callTool(parsed.server, parsed.tool, args);
              const out = text == null ? '' : String(text);
              content.set(id, out);
              state.set(id, 'done');
              usedModel.set(id, `mcp:${parsed.server}.${parsed.tool}`);
              usage.set(id, { ms: Date.now() - t0 });
              emit({
                type: 'node:done',
                id,
                model: `mcp:${parsed.server}.${parsed.tool}`,
                content: out,
                usage: { ms: Date.now() - t0 },
                verdict: null,
                status: 'done',
              });
            } catch (err) {
              const error = String((err && err.message) || err);
              state.set(id, 'failed');
              emit({
                type: 'node:failed',
                id,
                tried: [{ model: `mcp:${String(node.tool ?? '')}`, error }],
              });
            }
            return;
          }

          const prompt = composePrompt(node, preds.get(id) || [], getContent);
          const models = [node.model, ...(node.fallback || [])].filter(Boolean);
          const tried = [];
          for (const m of models) {
            try {
              const t0 = Date.now();
              // 流式只是预览：delta 不改变状态，node:done 仍是唯一完成信号
              const onDelta = (chunk) => {
                if (chunk == null || chunk === '') return;
                emit({ type: 'node:delta', id, chunk: String(chunk) });
              };
              // 推理强度按模型各自取：主模型用 node.reasoningEffort，
              // 兜底模型用自己的 fallbackEfforts[provider/model]（缺省 = 模型默认）
              const effort = m === node.model
                ? node.reasoningEffort
                : (node.fallbackEfforts && typeof node.fallbackEfforts === 'object'
                    ? node.fallbackEfforts[m]
                    : '');
              const res = await callLLM(
                // node.onDelta 是兜底：server 的 callLLM 包装层没透传第三个参数时，
                // llm.mjs 仍能从节点对象上拿到流式回调。
                { ...node, model: m, reasoningEffort: effort, onDelta },
                prompt,
                { tried, onDelta },
              );
              const text = typeof res === 'string' ? res : res.content || '';
              if (!text.trim()) throw new Error('空输出');
              content.set(id, text);
              usedModel.set(id, m);
              usage.set(id, { ...(res.usage || {}), ms: Date.now() - t0 });
              state.set(id, 'done');
              usedModel.set(id, m);
              usage.set(id, { ...(res.usage || {}), ms: Date.now() - t0 });

              // 结果判断：节点配了 verify 时，跑完先过一道检查
              let verdict = null;
              let finalState = 'done';
              if (opts.verifyNode) {
                try {
                  const v = await opts.verifyNode(node, text);
                  if (v && v.pending) finalState = 'review';
                  else if (v) verdict = v;
                } catch (err) {
                  verdict = {
                    by: node.verify || 'unknown',
                    pass: false,
                    reason: `判定出错：${(err && err.message) || err}`,
                  };
                }
              }
              state.set(id, finalState);

              emit({
                type: 'node:done',
                id,
                model: m,
                content: text,
                usage: usage.get(id),
                verdict,
                status: finalState,
                tried: tried.slice(),
              });
              return;
            } catch (err) {
              tried.push({ model: m, error: String((err && err.message) || err) });
              emit({ type: 'node:retry', id, model: m, error: tried.at(-1).error });
            }
          }
          state.set(id, 'failed');
          emit({ type: 'node:failed', id, tried });
        })
      );
      continue;
    }

    // 本轮有节点因上游失败而转 blocked → 必须再跑一轮，
    // 让依赖它的节点被判成 blocked(upstream-failed)，而不是掉进下面的死锁分支。
    if (justBlocked > 0) continue;

    // 没有节点就绪、也没有新阻塞：剩下的都在等永远不会到来的前驱 → 才是真成环。
    let stuck = 0;
    for (const st of state.values()) if (st === 'pending') stuck++;
    if (stuck === 0) break;
    for (const [id, st] of state) {
      if (st === 'pending') {
        state.set(id, 'blocked');
        emit({ type: 'node:blocked', id, reason: 'deadlock' });
      }
    }
    break;
  }

  const summary = { done: [], failed: [], blocked: [], review: [] };
  for (const [id, st] of state) {
    if (!targets.has(id)) continue;
    if (st === 'done') summary.done.push(id);
    else if (st === 'failed') summary.failed.push(id);
    else if (st === 'blocked') summary.blocked.push(id);
    else if (st === 'review') summary.review.push(id);
  }
  emit({ type: 'run:end', summary });
  return { state, content, usedModel, usage, summary };
}

/**
 * 组装单个节点的 prompt：只有「要做什么 / 吃什么材料 / 做到什么程度」。
 * 这就是上下文边界的全部，不给别支的任何内容。
 */
export function composePrompt(node, predIds, getContent) {
  const parts = [];
  if (node.task) parts.push(node.task.trim());
  const materials = collectMaterials(predIds, getContent);
  if (materials) parts.push(materials);
  if (node.criteria) parts.push(`完成标准：${node.criteria.trim()}`);
  return parts.join('\n\n');
}

/**
 * 用量预估（只算 token，不估钱 —— 价格会变，编数字比不显示更糟）。
 *
 * 每个节点按 task + criteria + 上游已有 content 的字符数估算 prompt：
 * 中英文混合一律按「字符数 / 2」粗算，再加一个固定输出假设 400 tok。
 *
 * @returns {{ total: number, perNode: Record<string, number> }}
 */
export function estimateTokens(board) {
  const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
  if (!nodes.length) return { total: 0, perNode: {} };

  const { preds } = buildIndex(board);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const perNode = {};
  let total = 0;

  for (const node of nodes) {
    const upstream = (preds.get(node.id) || [])
      .map((id) => (byId.get(id)?.content || '').trim())
      .join('\n\n');
    const chars = `${node.task || ''}${node.criteria || ''}${upstream}`.length;
    const tokens = Math.ceil(chars / 2) + 400;
    perNode[node.id] = tokens;
    total += tokens;
  }

  return { total, perNode };
}
