// orchestrator.mjs —— 调度根节点（对话入口）的共享规则。
//
// 从 preset-gen.mjs 搬出来的最小集合：预设生成已下线，但画布仍然需要这些规则：
//   1. 新建画布时给根节点一份默认人格与验收标准（boards.mjs 用）
//   2. 根节点不能有上游（PUT /api/boards/:id 的校验，server.mjs 用）
//
// 「调度根节点」= type === 'orchestrator' 的节点，一张画布最多一张 ——
// 它就是对话入口，也是（历史版本的）persona 来源。

/** 所有要嵌进行内文本的字段先压成单行 */
function flat(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 画布上的调度根节点（type === 'orchestrator'）。
 * 产品约定：一张画布最多一张 —— 它就是对话入口。
 */
export function findOrchestrators(board) {
  const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
  return nodes.filter((n) => n && n.type === 'orchestrator');
}

/**
 * 根节点（对话入口）的默认人格：刻意写得很短。
 * 子节点内容随时会变，所以只列一份 label + 一句用途的清单，不展开 criteria；
 * 具体执行交给后续节点的 AgentFlow 流。
 * 用户可以自己改写——只在新建调度卡时用这份默认值。
 */
export function orchestratorPersona(board) {
  const name = flat(board?.name) || '未命名画布';
  return [
    `你是「${name}」的对话入口。`,
    '',
    '你只负责和用户对话：问清需求、确认关键信息。',
    '',
    '需求明确后，严格按照后续节点的 AgentFlow 流去执行，不要自己直接产出结果。',
  ].join('\n');
}

/** 根节点的默认验收标准 */
export function orchestratorCriteria() {
  return '用户需求已确认清楚；后续节点按流程顺序全部执行完成，最终产出交给用户。';
}

/** 根节点不能有上游（它是流程起点、对话入口） */
export function assertRootHasNoUpstream(board) {
  const roots = findOrchestrators(board);
  if (!roots.length) return;
  const incoming = new Set((board?.edges || []).map((e) => String(e.to)));
  const bad = roots.filter((n) => incoming.has(String(n.id)));
  if (bad.length) {
    throw Object.assign(new Error('根节点（调度卡）不能有上游节点'), { status: 400 });
  }
}
