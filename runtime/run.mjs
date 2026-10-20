#!/usr/bin/env node
// run.mjs —— 命令行跑画布，不开浏览器也能用。
//
//   node run.mjs                      跑整个 data/board.json
//   node run.mjs n2 n3                只跑指定节点（及其下游）
//   node run.mjs --task "赛博朋克侦探"  覆盖根节点的题材再跑

import { runBoard } from './engine.mjs';
import { loadBoard, saveBoard, loadConfig } from './store.mjs';
import { normalizeConfig, makeCaller } from './llm.mjs';

const args = process.argv.slice(2);
let subject = '';
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--task') subject = args[++i] || '';
  else if (!args[i].startsWith('-')) targets.push(args[i]);
}

const board = await loadBoard();
if (!board) {
  console.error('没有 data/board.json，先跑一次 node server.mjs 生成初始画布');
  process.exit(1);
}

// 有题材时塞给所有根节点（没有前驱的节点）
if (subject) {
  const hasPred = new Set(board.edges.map((e) => e.to));
  for (const n of board.nodes) {
    if (!hasPred.has(n.id)) n.task = `${n.task}\n\n题材：${subject}`;
  }
}

const cfg = normalizeConfig(await loadConfig());
// 模型调用只走 DSH 内核的 bridge；目录可用 AGENTFLOW_BRIDGE_DIR 换，
// 默认与插件写入的 ~/.dsh/agent-flow/data/dsh-bridge.json 对齐。
const callLLM = makeCaller({
  bridgeDir: process.env.AGENTFLOW_BRIDGE_DIR || undefined,
  mock: cfg.mock,
  skillDirs: cfg.skillDirs,
});

console.log(`模式：${cfg.mock ? 'mock' : '真实调用'}\n`);

const t0 = Date.now();
const result = await runBoard(board, {
  targets: targets.length ? targets : undefined,
  callLLM,
  emit: (ev) => {
    const t = ((Date.now() - t0) / 1000).toFixed(1);
    if (ev.type === 'node:start') console.log(`[${t}s] ▶ ${ev.id}`);
    else if (ev.type === 'node:done') {
      const u = ev.usage || {};
      console.log(`[${t}s] ✓ ${ev.id}  ${ev.model}  ${u.promptTokens || 0}/${u.completionTokens || 0} tok  ${u.ms || 0}ms`);
      const preview = (ev.content || '').split('\n').slice(0, 3).join('\n    ');
      console.log(`    ${preview}\n`);
    } else if (ev.type === 'node:retry') console.log(`[${t}s] ↻ ${ev.id} ${ev.model} 失败：${ev.error}`);
    else if (ev.type === 'node:failed') console.log(`[${t}s] ✗ ${ev.id} 全部模型失败`);
    else if (ev.type === 'node:blocked') console.log(`[${t}s] ⊘ ${ev.id} 阻塞（${ev.reason}）`);
  },
});

// 把物料写回去，下次打开网页就能看到
for (const n of board.nodes) {
  const c = result.content.get(n.id);
  if (c) n.content = c;
  const st = result.state.get(n.id);
  if (st) n.status = st;
  const m = result.usedModel.get(n.id);
  if (m) n.usage = { model: m, ...(result.usage.get(n.id) || {}) };
}
await saveBoard(board);

const { done, failed, blocked } = result.summary;
console.log(`\n完成 ${done.length} · 失败 ${failed.length} · 阻塞 ${blocked.length}`);
process.exit(failed.length || blocked.length ? 1 : 0);
