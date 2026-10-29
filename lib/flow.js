/**
 * 画布执行状态机（纯函数，不碰 fs / 不碰 ctx）。
 *
 * 一次「跟着画布走」的对话 = 一个 run：
 *   1. 用户输入的话进根节点（调度卡）；根节点按自己的 task/criteria 干活
 *   2. 根节点显式声明完成后，算出下一层「可做」的节点
 *   3. 这一层有几个节点，就必须建几个 teammate（name 用节点 id），
 *      把它们各自的 task + 上游产出摘要派下去
 *   4. 每个节点都被 agentflow_node_done 显式标记完成后，再算下一层
 *   5. 全部节点完成 → run 收束
 *
 * 这里只负责「该谁做、做完没、下一条指令说什么」，真正的注入/拦工具在
 * lib/commands.js 里接线。保持纯函数是为了能单测：同样的画布 + 同样的
 * 完成顺序，必须推出同样的指令文本。
 *
 * @module lib/flow
 */

/** 节点完成必须交出产出，太短的视为没做。 */
const MIN_OUTPUT = 10;
/** 单个节点产出上限：画布别把对话上下文灌爆。 */
const MAX_OUTPUT = 8000;
/** 一条指令文本的硬上限。 */
const MAX_INSTRUCTION = 6000;

const STATE_PENDING = 'pending';
const STATE_DONE = 'done';
/** 没有任务的节点（占位卡）自动跳过，否则整张图会卡死在它身上。 */
const STATE_SKIPPED = 'skipped';

function text(value) {
  return typeof value === 'string' ? value : '';
}

function clip(value, limit) {
  const raw = text(value);
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, Math.max(0, limit - 1))}…`;
}

/** 根节点识别：优先 id/label 带调度含义的卡，其次取唯一无上游的节点。 */
function pickRoot(nodes) {
  const byDownstream = new Map();
  for (const node of nodes) byDownstream.set(node.id, 0);
  for (const node of nodes) {
    for (const up of node.upstream) {
      if (byDownstream.has(up)) byDownstream.set(up, (byDownstream.get(up) ?? 0) + 1);
    }
  }
  const scheduler =
    nodes.find((node) => node.type === 'orchestrator') ??
    nodes.find((node) => node.id === 'orchestrator' || /调度|orchestrator/i.test(`${node.id} ${node.label}`));
  if (scheduler) return scheduler;

  const roots = nodes.filter((node) => node.upstream.filter((up) => byDownstream.has(up)).length === 0);
  if (roots.length === 1) return roots[0];
  if (roots.length === 0) return null;
  // 多个无上游节点：挑下游最多的那张当入口
  let best = roots[0];
  for (const node of roots) {
    if ((byDownstream.get(node.id) ?? 0) > (byDownstream.get(best.id) ?? 0)) best = node;
  }
  return best;
}

/** 每次 run 一个随机后缀，保证 teammate 名在 roster 里不会被复用。 */
export function newRunToken() {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

/**
 * 建一个 run。节点缺 task 的自动标 skipped（占位卡），避免死锁。
 * @param {object} input
 * @param {object} input.board 已归一化的画布 {id,name,nodes,edges}
 * @param {string} input.seed 用户输入的那句话
 * @param {string} input.ownerId 发起这次 run 的 agent id（只有它能标记完成）
 * @param {number} [input.runIndex] 该 agent 的第几次 run（>1 时 teammate 名带 -rN 后缀）
 * @returns {object} run
 */
export function createRun({ board, boardId, boardName, seed, ownerId, runIndex = 1, now = Date.now() }) {
  const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
  const byId = new Map();
  for (const node of nodes) {
    if (!node || !node.id || byId.has(node.id)) continue;
    byId.set(node.id, {
      id: String(node.id),
      label: text(node.label) || String(node.id),
      // 只有空白字符的任务当占位卡：否则它会变成"有任务但没内容"的死节点
      task: text(node.task).trim(),
      criteria: text(node.criteria).trim(),
      // 引擎的权威标记：调度卡 type === 'orchestrator'（旧画布没有这个字段）
      type: text(node.type).trim(),
      model: text(node.model),
      provider: text(node.provider),
      reasoningEffort: text(node.reasoningEffort),
      skills: Array.isArray(node.skills) ? node.skills.map(String).filter(Boolean) : [],
      tools: Array.isArray(node.tools) ? node.tools.map(String).filter(Boolean) : [],
      tool: text(node.tool),
      upstream: Array.isArray(node.upstream) ? node.upstream.map(String) : [],
    });
  }

  const status = new Map();
  /** 被跳过的节点与原因：占位卡没人做，MCP 节点命令模式暂不执行 */
  const skipped = new Map();
  for (const [id, node] of byId) {
    if (node.task) {
      status.set(id, STATE_PENDING);
      continue;
    }
    status.set(id, STATE_SKIPPED);
    skipped.set(id, node.type === 'mcp' ? 'MCP 节点（命令模式暂不执行）' : '占位卡（没有任务）');
  }

  const index = Number.isFinite(runIndex) && runIndex > 0 ? Math.floor(runIndex) : 1;
  // roster 名字跨 DSH 重启也不复用（实测 restart 后同名仍报 TEAM_MEMBER_NAME_TAKEN），
  // 而 runIndex 是内存态会归零 —— 所以名字必须自带随机后缀，不依赖计数器。
  const token = newRunToken();
  const run = {
    boardId: String(boardId || board?.id || ''),
    boardName: text(boardName) || text(board?.name) || String(boardId || '画布'),
    seed: text(seed),
    ownerId: String(ownerId || ''),
    nodes: byId,
    status,
    skipped,
    outputs: new Map(),
    rootId: '',
    startedAt: now,
    finishedAt: 0,
    stuck: '',
    /** 已经 steer 过派发指令的节点（只是"要了"，不代表真 spawn 了）。 */
    requested: new Set(),
    /** 真的 spawn 成功的节点（由 post-execute 观察到成功的 spawn_teammate 才置位）。 */
    spawned: new Set(),
    /** nodeId -> 实际用的 teammate 名（run 内唯一，避开 roster 名字不复用）。 */
    spawnNames: new Map(),
    /** 本 agent 的第几次 run（仅诊断用，不参与命名）。 */
    runIndex: index,
    /** 这一次 run 的随机后缀：teammate 名 = <节点id清洗>-<token>。 */
    token,
    /** 最后一次有进展（完成/派发/催办）的时间，超时兜底用。 */
    lastAdvanceAt: now,
  };
  const root = pickRoot([...byId.values()]);
  run.rootId = root ? root.id : '';
  // 建 run 的这一刻就没有可执行节点（全是占位卡）：直接判死，别留一个永远不动的 run
  if (run.rootId && pendingNodes(run).length === 0) {
    run.finishedAt = now;
  } else if (!run.rootId) {
    run.stuck = '画布没有入口节点（既没有调度卡，也没有无上游的节点）';
  }
  return run;
}

/**
 * 节点对应的 teammate 名。
 *
 * Agent Teams 的 roster 名字**永不复用**（同名第二次直接报 TEAM_MEMBER_NAME_TAKEN，
 * 实测连 DSH 重启后都还记着），所以每次 run 都给一个随机后缀：
 * `<节点id清洗>-<token>`。派发、pre-execute 校验、回收都用这个名字，
 * 但 node_done 仍然用真实节点 id。
 */
export function spawnNameFor(run, nodeId) {
  const id = String(nodeId ?? '');
  const cached = run.spawnNames.get(id);
  if (cached) return cached;
  // roster 约束：^[a-z0-9]+(-[a-z0-9]+)*$、<=64、不能叫 lead
  let base = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) base = 'node';
  if (/^[0-9]/.test(base)) base = `n${base}`;
  if (base === 'lead') base = 'lead-node';
  const suffix = `-${run.token || 'run'}`;
  let name = `${base.slice(0, 60 - suffix.length)}${suffix}`;
  // 清洗可能撞名（"a b" 与 "a-b" 都变 a-b，两个中文 id 都变 node）：
  // 同 run 内保证唯一，否则 roster 会拒绝第二个同名 spawn
  const used = new Set(run.spawnNames.values());
  if (used.has(name)) {
    let n = 2;
    while (used.has(`${name}-${n}`)) n += 1;
    name = `${name}-${n}`;
  }
  run.spawnNames.set(id, name);
  return name;
}

/** teammate 名反查节点 id（pre-execute / post-execute 用）。 */
export function nodeForSpawnName(run, name) {
  const wanted = String(name ?? '');
  for (const [id] of run.nodes) {
    if (spawnNameFor(run, id) === wanted) return id;
  }
  return '';
}

/** 是否还在跑（没完成、没卡死）。 */
export function isActive(run) {
  if (!run || !run.rootId) return false;
  if (run.finishedAt) return false;
  if (run.stuck) return false;
  return true;
}

/** 节点是否已完成（done 或 skipped）。 */
function satisfied(run, id) {
  const state = run.status.get(id);
  return state === STATE_DONE || state === STATE_SKIPPED;
}

/**
 * 下一层可执行的节点：pending 且所有已知上游都已满足。
 * 未知上游（画布被改过）直接忽略，免得整张图被幽灵节点卡住。
 */
export function readyNodes(run) {
  const out = [];
  for (const [id, node] of run.nodes) {
    if (run.status.get(id) !== STATE_PENDING) continue;
    const blocked = node.upstream.some((up) => run.nodes.has(up) && !satisfied(run, up));
    if (!blocked) out.push(node);
  }
  return out;
}

/** 还没完成的节点（含 pending），用于判断是否收束。 */
export function pendingNodes(run) {
  return [...run.nodes.values()].filter((node) => run.status.get(node.id) === STATE_PENDING);
}

/** 已完成节点的产出摘要，派给下游时当上下文用。 */
function upstreamDigest(run, node, limit) {
  const parts = [];
  for (const up of node.upstream) {
    if (!run.nodes.has(up)) continue;
    const output = run.outputs.get(up);
    if (!output) continue;
    const label = run.nodes.get(up).label;
    parts.push(`- ${up}「${label}」产出：${clip(output, 400)}`);
  }
  return clip(parts.join('\n'), limit);
}

/**
 * 标记一个节点完成。
 *
 * 校验（硬）：
 *   - run 还在跑
 *   - 这个节点属于本画布、且当前可做（上游都完成了）
 *   - 产出不是空话（长度 >= MIN_OUTPUT）
 *   - 不能重复标记
 *
 * @returns {{ok: true, node: object, state: 'running'|'done'|'stuck'} | {ok: false, reason: string}}
 */
export function markDone(run, nodeId, output) {
  if (!run) return { ok: false, reason: '当前没有进行中的画布' };
  if (run.finishedAt) return { ok: false, reason: '这次画布已经结束了' };
  if (run.stuck) return { ok: false, reason: `画布已卡住：${run.stuck}` };
  const node = run.nodes.get(String(nodeId ?? ''));
  if (!node) return { ok: false, reason: `画布「${run.boardName}」里没有节点 ${nodeId}` };
  if (run.status.get(node.id) === STATE_DONE) return { ok: false, reason: `节点 ${node.id} 已经完成过了` };
  if (run.status.get(node.id) === STATE_SKIPPED) return { ok: false, reason: `节点 ${node.id} 没有任务，已自动跳过` };
  const ready = readyNodes(run).some((item) => item.id === node.id);
  if (!ready) {
    const waiting = node.upstream.filter((up) => run.nodes.has(up) && !satisfied(run, up));
    return { ok: false, reason: `节点 ${node.id} 的前置还没完成：${waiting.join('、') || '未知'}` };
  }
  const value = text(output).trim();
  if (value.length < MIN_OUTPUT) {
    return { ok: false, reason: `节点 ${node.id} 的产出太短（${value.length} 字），请把实际结果交出来再标记完成` };
  }
  // 非根节点必须先真的派出去过：否则模型可以自己把下游做完，画布退化成单 agent
  if (node.id !== run.rootId && !run.spawned.has(node.id)) {
    return {
      ok: false,
      reason: `节点 ${node.id} 还没派发过 teammate。当前层要按画布派发（teammate 名 ${spawnNameFor(run, node.id)}），拿到它的产出后再标记完成`,
    };
  }
  run.outputs.set(node.id, clip(value, MAX_OUTPUT));
  run.status.set(node.id, STATE_DONE);
  run.lastAdvanceAt = Date.now();

  if (pendingNodes(run).length === 0) {
    run.finishedAt = Date.now();
    return { ok: true, node, state: 'done' };
  }
  const next = readyNodes(run);
  if (next.length === 0) {
    run.stuck = '剩下的节点互相等待，没有可执行的（检查画布连线是否成环）';
    return { ok: true, node, state: 'stuck' };
  }
  return { ok: true, node, state: 'running' };
}

/**
 * 当前该派发的节点：pending、可执行、还没要过、也还没派出去。
 * 根节点永远不派发——它就是这段对话自己。
 */
export function toDispatch(run) {
  if (!isActive(run)) return [];
  const out = [];
  for (const node of readyNodes(run)) {
    if (node.id === run.rootId) continue;
    if (run.requested.has(node.id) || run.spawned.has(node.id)) continue;
    out.push(node);
  }
  return out;
}

/** 已经 steer 过派发指令（只是"要了"，等 post-execute 确认真的 spawn）。 */
export function markRequested(run, ids) {
  for (const id of ids ?? []) run.requested.add(String(id));
  run.lastAdvanceAt = Date.now();
}

/** 兼容旧名字：等同 markRequested。 */
export const markDispatched = markRequested;

/**
 * 观察到一个 teammate 真的 spawn 成功：这是唯一能证明"派发发生了"的事实。
 * @returns {string} 命中的节点 id（不是本 run 的节点则返回 ''）
 */
export function markSpawned(run, nodeId) {
  const id = String(nodeId ?? '');
  if (!run || !run.nodes.has(id)) return '';
  run.requested.delete(id);
  run.spawned.add(id);
  run.lastAdvanceAt = Date.now();
  return id;
}

/**
 * 撞名兜底：spawn 被 roster 拒（名字已被占用）时，给这个节点换一个新名字。
 *
 * 概率很低（随机后缀 4 位 base36），但真撞上时不能卡死整个 run：
 * 换名后清掉 requested/spawned 标记，turn-stopping 会用新名字重新派发。
 *
 * @returns {string} 新名字；节点不属于本 run 时返回 ''
 */
export function regenerateSpawnName(run, nodeId) {
  const id = String(nodeId ?? '');
  if (!run || !run.nodes.has(id)) return '';
  run.spawnNames.delete(id);
  run.requested.delete(id);
  run.spawned.delete(id);
  run.lastAdvanceAt = Date.now();
  // 再取一次名字：token 相同会得到同名，所以这里用节点级 salt 换一个新后缀
  const fresh = `-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
  const previous = spawnNameFor(run, id);
  const [base] = previous.split(new RegExp(`-${run.token}$`));
  const name = `${(base || previous).slice(0, 60 - fresh.length)}${fresh}`;
  run.spawnNames.set(id, name);
  return name;
}

/** 已请求派发、但还没观察到 spawn 成功的节点（超时兜底重试用）。 */
export function awaitingSpawn(run) {
  if (!isActive(run)) return [];
  return [...run.requested].filter((id) => !run.spawned.has(id) && run.status.get(id) === STATE_PENDING);
}

/** 画布全景（状态行用）。 */
export function renderStatus(run) {
  const lines = [];
  for (const [id, node] of run.nodes) {
    const state = run.status.get(id);
    const mark =
      state === STATE_DONE
        ? '✓'
        : state === STATE_SKIPPED
          ? '－'
          : run.spawned.has(id)
            ? '…'
            : run.requested.has(id)
              ? '~'
              : '·';
    lines.push(`${mark} ${id}「${node.label}」`);
  }
  return lines.join(' ');
}

function nodeBrief(run, node) {
  const parts = [`- ${node.id}「${node.label}」`];
  if (node.task) parts.push(`  任务：${clip(node.task, 600)}`);
  if (node.criteria) parts.push(`  验收：${clip(node.criteria, 400)}`);
  // 画布上配的模型/技能/工具要传给 teammate：spawn_teammate 没法指定模型，
  // 但把配置写进 prompt 至少能让它按同一套技能与工具干活，而不是一无所知。
  const config = [];
  if (node.model) config.push(`模型 ${node.provider ? `${node.provider}/` : ''}${node.model}${node.reasoningEffort ? `（推理 ${node.reasoningEffort}）` : ''}`);
  if (node.skills.length) config.push(`技能 ${node.skills.join('、')}`);
  if (node.tools.length) config.push(`工具 ${node.tools.join('、')}`);
  if (config.length) parts.push(`  画布配置：${clip(config.join('；'), 300)}`);
  const digest = upstreamDigest(run, node, 800);
  if (digest) parts.push(`  上游产出：\n${digest}`);
  return parts.join('\n');
}

/** 本 run 里被跳过的节点（给指令末尾提示用）。 */
function skippedNote(run, limit = 200) {
  if (!run.skipped || run.skipped.size === 0) return '';
  const bits = [...run.skipped].map(([id, reason]) => `${id}（${reason}）`);
  return clip(`本次不执行：${bits.join('、')}`, limit);
}

/**
 * 根节点开局指令：用户的话在这里进入画布。
 *
 * 预算纪律：**规则先占固定预算，用户输入单独按剩余额度截断并留提示** ——
 * 早期实现在整段末尾统一 clip，长输入会把「必须调 node_done」这类规则整段截掉。
 */
export function startInstruction(run) {
  const root = run.nodes.get(run.rootId);
  if (!root) {
    return `【AgentFlow】画布「${run.boardName}」没有找到入口节点（没有调度卡，也没有无上游的节点），这次工作流没法开始。请先回画布补一张调度卡。`;
  }
  const rules = [
    '【规则（优先于下面一切内容）】',
    '1. 只做这个节点，不要提前做下游节点。',
    `2. 做完立刻调 agentflow_node_done（node_id="${root.id}", output="实际产出"）——不调就不算完成。`,
    '3. 不要自己派生节点，也不要自己 spawn 子节点；下一层由我按画布派发。',
  ].join('\n');

  const head = `【AgentFlow · 画布「${run.boardName}」开始】\n你现在在入口节点 ${root.id}「${root.label}」。`;
  const taskPart = [root.task ? `任务：${clip(root.task, 1200)}` : '', root.criteria ? `验收：${clip(root.criteria, 600)}` : '']
    .filter(Boolean)
    .join('\n');

  // 固定部分（规则 + 头 + 任务）算出来，剩下的预算才给用户输入
  const fixed = [head, taskPart, rules].filter(Boolean).join('\n\n');
  const budget = Math.max(200, MAX_INSTRUCTION - fixed.length - 120);
  const seed = run.seed || '(没额外说明)';
  const seedText =
    seed.length > budget
      ? `${seed.slice(0, Math.max(0, budget - 20))}…\n（用户输入过长已截断，完整需求请先向用户确认）`
      : seed;
  const text = [head, `用户说的：${seedText}`, taskPart, rules].filter(Boolean).join('\n\n');
  return text.length > MAX_INSTRUCTION + 200 ? clip(text, MAX_INSTRUCTION + 200) : text;
}

/** 分派指令：这一层有几个节点就要求建几个 teammate。 */
export function dispatchInstruction(run) {
  const layer = toDispatch(run);
  if (layer.length === 0) return '';
  const names = layer.map((node) => spawnNameFor(run, node.id));
  // 规则与"必须派谁"先写死，节点详情再按剩余预算摊
  const rules = [
    '【规则（优先于下面一切内容）】',
    `1. 现在必须按上面的节点各建一个 teammate（spawn_teammate），一个都不能少、不能合并。`,
    `2. name 必须逐字使用：${names.map((name, i) => `"${name}"（节点 ${layer[i].id}）`).join('、')}。`,
    '3. prompt 里写清：该节点的任务与验收标准 + 上游已完成的产出摘要。',
    '4. 不要自己代做这些节点；派完等他们回报。',
    '5. 每个 teammate 回报后，用它的实际产出调 agentflow_node_done(node_id=真实节点 id, output=产出)。',
  ].join('\n');
  const head = `【AgentFlow · 派发下一层（${layer.length} 个节点）】`;
  const budget = Math.max(300, MAX_INSTRUCTION - rules.length - head.length - 80);
  const perNode = Math.max(120, Math.floor(budget / Math.max(1, layer.length)));
  const body = layer
    .map((node) => {
      const brief = nodeBrief(run, node);
      return brief.length > perNode ? `${clip(brief, perNode)}` : brief;
    })
    .join('\n');
  const note = skippedNote(run);
  const text = [head, body, rules, note].filter(Boolean).join('\n\n');
  return text.length > MAX_INSTRUCTION + 400 ? clip(text, MAX_INSTRUCTION + 400) : text;
}

/** 卡住时的说明。 */
export function stuckInstruction(run) {
  return `【AgentFlow】画布「${run.boardName}」剩下的节点互相等待，没有可执行的（检查连线是否成环）：${run.stuck || '无'}`;
}

/** 全部完成时的收束文本。 */
export function summaryInstruction(run) {
  const lines = [`【AgentFlow · 画布「${run.boardName}」全部完成】`];
  for (const [id, node] of run.nodes) {
    if (run.status.get(id) !== STATE_DONE) continue;
    lines.push(`- ${id}「${node.label}」：${clip(run.outputs.get(id) || '', 300)}`);
  }
  return clip(lines.join('\n'), MAX_INSTRUCTION);
}

/**
 * 进行态的签名：只有这个签名变化时才值得再注入一次提示。
 * 每一步都重复注入同样的提示会白烧 token（长流程累积起来很可观）。
 */
export function hintSignature(run) {
  if (!run || !isActive(run)) return '';
  const done = [...run.status].filter(([, state]) => state === STATE_DONE).map(([id]) => id);
  const waiting = [...run.spawned].filter((id) => run.status.get(id) === STATE_PENDING);
  const todo = toDispatch(run).map((node) => node.id);
  const rootPending = run.status.get(run.rootId) === STATE_PENDING ? '1' : '0';
  return [rootPending, done.sort().join(','), waiting.sort().join(','), todo.sort().join(',')].join('|');
}

/** 每步注入的进行态提示（很短，防止模型忘了自己在工作流里）。 */
export function stepHint(run) {
  if (!run || !isActive(run)) return '';
  const done = [...run.status].filter(([, state]) => state === STATE_DONE).map(([id]) => id);
  const waiting = [...run.spawned].filter((id) => run.status.get(id) === STATE_PENDING);
  const todo = toDispatch(run).map((node) => node.id);
  const rootPending = run.status.get(run.rootId) === STATE_PENDING;
  const parts = [`[画布「${run.boardName}」进行中] 已完成：${done.join('、') || '无'}。`];
  if (rootPending) parts.push(`入口节点 ${run.rootId} 还没调 agentflow_node_done。`);
  if (waiting.length) parts.push(`已派发待回报：${waiting.join('、')}。`);
  if (todo.length) parts.push(`待派发：${todo.join('、')}。`);
  if (!waiting.length && !todo.length && !rootPending) parts.push('当前没有可派发的节点。');
  parts.push('只做当前层的节点，做完必须调 agentflow_node_done；不要自己派生节点。');
  return clip(parts.join(''), 700);
}

/** 给工具返回的、人能看的一行。 */
export function statusLine(run) {
  const done = [...run.status].filter(([, state]) => state === STATE_DONE).length;
  const total = [...run.status].filter(([, state]) => state !== STATE_SKIPPED).length;
  return `画布「${run.boardName}」：${done}/${total} 完成`;
}

export const FLOW_STATES = { STATE_PENDING, STATE_DONE, STATE_SKIPPED };
export const FLOW_LIMITS = { MIN_OUTPUT, MAX_OUTPUT, MAX_INSTRUCTION };

// ---------------------------------------------------------------------------
// 落盘 / 恢复：run 只在内存里的话，DSH 一重启工作流就断在半路
// ---------------------------------------------------------------------------

/**
 * 把 run 压成可 JSON 化的普通对象（Map/Set 都要摊平）。
 * @param {object} run
 * @returns {object|null}
 */
export function serializeRun(run) {
  if (!run || !run.rootId) return null;
  return {
    v: 1,
    boardId: run.boardId,
    boardName: run.boardName,
    seed: run.seed,
    ownerId: run.ownerId,
    rootId: run.rootId,
    token: run.token,
    runIndex: run.runIndex,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    stuck: run.stuck,
    lastAdvanceAt: run.lastAdvanceAt,
    nodes: [...run.nodes.values()],
    status: [...run.status],
    skipped: [...(run.skipped ?? new Map())],
    outputs: [...run.outputs],
    requested: [...run.requested],
    spawned: [...run.spawned],
    spawnNames: [...run.spawnNames],
  };
}

/**
 * 从落盘数据恢复一个 run（用于 DSH 重启后续跑）。
 *
 * 恢复时**故意清空 spawned / requested 并换一个新 token**：重启后原来的 teammate
 * 已经不存在，而 roster 还记得旧名字；不清的话既派不出去也等不到回报。
 *
 * @param {unknown} data serializeRun 的产物
 * @returns {object|null}
 */
export function deserializeRun(data) {
  if (!data || typeof data !== 'object' || !data.rootId || !Array.isArray(data.nodes)) return null;
  const nodes = new Map();
  for (const node of data.nodes) {
    if (!node || !node.id) continue;
    nodes.set(String(node.id), {
      id: String(node.id),
      label: text(node.label) || String(node.id),
      task: text(node.task),
      criteria: text(node.criteria),
      type: text(node.type),
      model: text(node.model),
      provider: text(node.provider),
      reasoningEffort: text(node.reasoningEffort),
      skills: Array.isArray(node.skills) ? node.skills.map(String) : [],
      tools: Array.isArray(node.tools) ? node.tools.map(String) : [],
      tool: text(node.tool),
      upstream: Array.isArray(node.upstream) ? node.upstream.map(String) : [],
    });
  }
  if (!nodes.has(String(data.rootId))) return null;
  const run = {
    boardId: text(data.boardId),
    boardName: text(data.boardName) || '(恢复的画布)',
    seed: text(data.seed),
    ownerId: text(data.ownerId),
    rootId: String(data.rootId),
    token: newRunToken(),
    runIndex: Number.isFinite(data.runIndex) ? data.runIndex : 1,
    nodes,
    status: new Map(Array.isArray(data.status) ? data.status : []),
    skipped: new Map(Array.isArray(data.skipped) ? data.skipped : []),
    outputs: new Map(Array.isArray(data.outputs) ? data.outputs : []),
    requested: new Set(),
    spawned: new Set(),
    spawnNames: new Map(),
    startedAt: Number.isFinite(data.startedAt) ? data.startedAt : Date.now(),
    finishedAt: Number.isFinite(data.finishedAt) ? data.finishedAt : 0,
    stuck: text(data.stuck),
    lastAdvanceAt: Date.now(),
  };
  // 状态表里的节点必须真实存在，防止坏文件造出幽灵节点
  for (const id of [...run.status.keys()]) if (!nodes.has(id)) run.status.delete(id);
  for (const [id, node] of nodes) if (!run.status.has(id)) run.status.set(id, node.task ? STATE_PENDING : STATE_SKIPPED);
  return run;
}
