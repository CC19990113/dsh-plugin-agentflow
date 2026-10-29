/**
 * lib/flow.js（画布执行状态机）的本地自测：纯函数、不碰 fs / ctx。
 *
 * 覆盖 P1 修复后的语义：
 *   - 根节点识别：type==='orchestrator' 优先，其次 id/label、唯一无上游、下游最多
 *   - 全占位画布建 run 即 finishedAt；无入口节点直接 stuck
 *   - toDispatch 永远排除根节点；requested/spawned 都不再重复派
 *   - markRequested 只是「要过」，markSpawned 才是「真的派出去了」
 *   - markDone：非根节点必须先 spawned；根节点不需要；产出太短/前置未完成/重复都拒
 *   - spawnNameFor：名字清洗、第一次用节点 id、第 N 次带 -rN；nodeForSpawnName 反查
 *   - 指令文本：规则先占预算（长 seed/长 task 截不掉规则）、长度上限
 *   - stepHint 区分「已派发待回报 / 待派发」；renderStatus 的 ~ / … / ✓ / －
 *
 * 运行：node test/flow.selftest.mjs
 */

import {
  createRun,
  isActive,
  readyNodes,
  pendingNodes,
  toDispatch,
  markRequested,
  markSpawned,
  regenerateSpawnName,
  serializeRun,
  deserializeRun,
  awaitingSpawn,
  spawnNameFor,
  nodeForSpawnName,
  markDone,
  startInstruction,
  dispatchInstruction,
  stuckInstruction,
  summaryInstruction,
  stepHint,
  renderStatus,
  statusLine,
  FLOW_LIMITS,
} from '../lib/flow.js';

// ---------------------------------------------------------------------------
// 迷你断言
// ---------------------------------------------------------------------------

const report = { passed: 0, failed: 0 };
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    report.passed += 1;
    console.log(`  ✓ ${name}`);
    return true;
  }
  report.failed += 1;
  failures.push(name + (detail ? ` — ${detail}` : ''));
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function eq(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  return ok(name, pass, pass ? '' : `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
// 造画布 / run
// ---------------------------------------------------------------------------

function node(id, { label = id, task = `任务 ${id}`, criteria = '', type = '', upstream = [], ...extra } = {}) {
  return { id, label, task, criteria, type, upstream, ...extra };
}

function board(nodes, name = '测试画布') {
  return { id: 'board-1', name, nodes, edges: [] };
}

function makeRun(nodes, { seed = '帮我把需求跑一遍', ownerId = 'agent-owner', boardName = '测试画布', runIndex = 1 } = {}) {
  return createRun({ board: board(nodes, boardName), boardId: 'board-1', boardName, seed, ownerId, runIndex, now: 1000 });
}

const GOOD = '这是节点的实际产出：拆成了 3 项，分别是 A、B、C。';

/** 根节点 + 一个子节点。 */
function simpleNodes() {
  return [
    node('orchestrator', { label: '调度', task: '把需求分下去' }),
    node('n1', { label: '拆需求', task: '拆成可执行任务', upstream: ['orchestrator'] }),
  ];
}

/** 把一个节点走完「请求派发 → 真的 spawn」两步。 */
function spawn(run, nodeId) {
  markRequested(run, [nodeId]);
  return markSpawned(run, nodeId);
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

function testRootAndStart() {
  console.log('\n▶ 根节点 / 开局指令');

  // type 优先：id/label 都不带调度语义也能认出来
  const typed = makeRun([
    node('boss', { label: 'Boss', task: '分发', type: 'orchestrator' }),
    node('a', { task: 'a', upstream: ['boss'] }),
    node('b', { task: 'b' }),
  ]);
  eq('type=orchestrator 优先当根', typed.rootId, 'boss');

  const run = makeRun(simpleNodes());
  eq('调度卡优先当根节点', run.rootId, 'orchestrator');
  eq('新建 run 是 active', isActive(run), true);
  eq('根节点不能派发（toDispatch 永远排除根）', toDispatch(run), []);
  eq('可执行节点只有根', readyNodes(run).map((item) => item.id), ['orchestrator']);
  eq('还没有已完成节点', pendingNodes(run).length, 2);
  eq('requested 初始为空', [...run.requested], []);
  eq('spawned 初始为空', [...run.spawned], []);

  const start = startInstruction(run);
  ok('开局指令含画布名', start.includes('画布「测试画布」开始'), start.slice(0, 80));
  ok('开局指令含用户输入', start.includes('帮我把需求跑一遍'));
  ok('开局指令指明根节点与任务', start.includes('入口节点 orchestrator') && start.includes('任务：把需求分下去'));
  ok('开局指令要求调 node_done', start.includes('agentflow_node_done') && start.includes('node_id="orchestrator"'));
  ok('开局指令禁止提前做下游', start.includes('只做这个节点') && start.includes('不要自己派生'));
  ok('开局指令不超上限', start.length <= FLOW_LIMITS.MAX_INSTRUCTION + 200, String(start.length));

  const hint = stepHint(run);
  ok('stepHint 含入口节点未完成', hint.includes('入口节点 orchestrator 还没调'), hint);
  ok('stepHint 含进行中', hint.includes('进行中'));
  ok('stepHint 不超 700 字', hint.length <= 700, String(hint.length));

  eq('statusLine 初始 0/2', statusLine(run), '画布「测试画布」：0/2 完成');
  ok('renderStatus 初始全是 ·', renderStatus(run).includes('· orchestrator'));

  // 多入口：挑下游最多的
  const multi = makeRun([
    node('a', { label: 'A' }),
    node('a1', { upstream: ['a'] }),
    node('a2', { upstream: ['a'] }),
    node('b', { label: 'B' }),
    node('b1', { upstream: ['b'] }),
  ]);
  eq('多入口挑下游最多的', multi.rootId, 'a');

  // 没有节点 / 没有入口
  const empty = createRun({ board: board([]), boardId: 'x', boardName: '空画布', seed: 's', ownerId: 'o' });
  eq('空画布没有 root', empty.rootId, '');
  eq('空画布建 run 即 stuck', Boolean(empty.stuck), true);
  eq('空画布不是 active', isActive(empty), false);
  ok('空画布开局指令说明没入口', startInstruction(empty).includes('没有找到入口节点'));

  // 全占位画布：建 run 就 finishedAt，不留一个永远不动的 run
  const placeholders = createRun({
    board: board([node('o', { label: '调度', task: '' }), node('n1', { task: '   ', upstream: ['o'] })]),
    boardId: 'p',
    boardName: '空任务画布',
    seed: 's',
    ownerId: 'o',
    now: 1234,
  });
  eq('全占位画布建 run 即 finishedAt', placeholders.finishedAt, 1234);
  eq('全占位画布不是 active', isActive(placeholders), false);
  eq('全占位画布 statusLine 0/0', statusLine(placeholders), '画布「空任务画布」：0/0 完成');
}

function testDispatchAndSpawn() {
  console.log('\n▶ 请求派发 → 真 spawn → 完成');

  const run = makeRun(simpleNodes());
  ok('超短产出被拒', markDone(run, 'orchestrator', '完成').ok === false);
  ok('超短产出给出原因', String(markDone(run, 'orchestrator', '完成').reason).includes('太短'));

  const doneRoot = markDone(run, 'orchestrator', GOOD);
  eq('根节点完成 ok', doneRoot.ok, true);
  eq('根节点完成后仍在跑', doneRoot.state, 'running');
  eq('根节点不需要 spawned', run.spawned.has('orchestrator'), false);
  eq('根节点完成后派发下一层', toDispatch(run).map((item) => item.id), ['n1']);
  ok('推进时间被刷新', run.lastAdvanceAt >= 1000);

  const dispatch = dispatchInstruction(run);
  ok(
    '派发指令含真实名字与节点映射',
    dispatch.includes(`"${spawnNameFor(run, 'n1')}"（节点 n1）`),
    dispatch.slice(0, 160),
  );
  ok('派发指令要求 spawn_teammate', dispatch.includes('spawn_teammate'));
  ok('派发指令要求一个节点一个 teammate', dispatch.includes('一个都不能少'));

  // 只是「要过」：还没 spawn，不能完成这个节点
  markRequested(run, ['n1']);
  eq('requested 记下节点', [...run.requested], ['n1']);
  eq('requested 后不再派发', toDispatch(run), []);
  eq('awaitingSpawn 列出还没 spawn 的', awaitingSpawn(run), ['n1']);
  ok('renderStatus 请求中标 ~', renderStatus(run).includes('~ n1'));
  ok('没真 spawn 前 node_done 被拒', String(markDone(run, 'n1', GOOD).reason).includes('还没派发过'));

  // 模拟 post-execute 观察到成功的 spawn_teammate
  eq('post-execute 用名字反查节点', nodeForSpawnName(run, spawnNameFor(run, 'n1')), 'n1');
  eq('markSpawned 返回命中的节点', markSpawned(run, 'n1'), 'n1');
  eq('spawn 后 requested 清空', [...run.requested], []);
  eq('spawn 后 spawned 有节点', [...run.spawned], ['n1']);
  eq('spawn 后 awaitingSpawn 为空', awaitingSpawn(run), []);
  ok('renderStatus 已派发标 …', renderStatus(run).includes('… n1'));
  ok('stepHint 显示已派发待回报', stepHint(run).includes('已派发待回报：n1'));

  const doneChild = markDone(run, 'n1', GOOD);
  eq('spawn 后可以标记完成', doneChild.ok, true);
  eq('最后一个节点完成 state=done', doneChild.state, 'done');
  eq('完成后不再 active', isActive(run), false);
  eq('pending 清空', pendingNodes(run).length, 0);
  eq('statusLine 2/2', statusLine(run), '画布「测试画布」：2/2 完成');
  ok('renderStatus 完成打 ✓', renderStatus(run).includes('✓ n1'));

  const summary = summaryInstruction(run);
  ok('summary 含全部完成', summary.includes('全部完成'));
  ok('summary 列出节点与产出', summary.includes('n1') && summary.includes('拆成了 3 项'));
  ok('完成后 markDone 报已结束', String(markDone(run, 'n1', GOOD).reason).includes('已经结束'));
}

function testRunIndexNames() {
  console.log('\n▶ teammate 名字（runIndex / 清洗 / 反查）');

  const first = makeRun(simpleNodes());
  ok('名字带本次 run 的随机后缀', /^n1-[a-z0-9]{4}$/.test(spawnNameFor(first, 'n1')), spawnNameFor(first, 'n1'));

  const second = makeRun(simpleNodes(), { runIndex: 2 });
  ok('第二次 run 名字与第一次不同', spawnNameFor(second, 'n1') !== spawnNameFor(first, 'n1'), `${spawnNameFor(first, 'n1')} vs ${spawnNameFor(second, 'n1')}`);
  eq('名字可反查回节点 id', nodeForSpawnName(second, spawnNameFor(second, 'n1')), 'n1');
  eq('未知名字反查为空', nodeForSpawnName(second, 'nope'), '');

  const sanitize = makeRun([
    node('orchestrator', { task: '分' }),
    node('Hello World!', { upstream: ['orchestrator'] }),
    node('123', { upstream: ['orchestrator'] }),
    node('lead', { upstream: ['orchestrator'] }),
    node('拆需求', { upstream: ['orchestrator'] }),
  ]);
  ok('大写与符号清洗', spawnNameFor(sanitize, 'Hello World!').startsWith('hello-world-'), spawnNameFor(sanitize, 'Hello World!'));
  ok('数字开头加 n 前缀', spawnNameFor(sanitize, '123').startsWith('n123-'), spawnNameFor(sanitize, '123'));
  ok('lead 是保留名', spawnNameFor(sanitize, 'lead').startsWith('lead-node-'), spawnNameFor(sanitize, 'lead'));
  ok('纯中文 id 有兜底名', spawnNameFor(sanitize, '拆需求').startsWith('node-'), spawnNameFor(sanitize, '拆需求'));
  eq('名字缓存稳定', spawnNameFor(sanitize, 'Hello World!'), spawnNameFor(sanitize, 'Hello World!'));

  const longId = 'x'.repeat(100);
  const long = makeRun([node('orchestrator', { task: '分' }), node(longId, { upstream: ['orchestrator'] })], {
    runIndex: 3,
  });
  ok('名字总长 <= 60', spawnNameFor(long, longId).length <= 60, String(spawnNameFor(long, longId).length));
  ok('长名字仍带后缀', /-[a-z0-9]{4}$/.test(spawnNameFor(long, longId)), spawnNameFor(long, longId));

  const run = makeRun(simpleNodes(), { runIndex: 2 });
  markDone(run, 'orchestrator', GOOD);
  const dispatch = dispatchInstruction(run);
  ok('派发指令使用本次 run 的名字', dispatch.includes(`"${spawnNameFor(run, 'n1')}"（节点 n1）`), dispatch.slice(0, 160));

  // 撞名兜底：换名后要能重新派发
  const collideRun = makeRun(simpleNodes());
  markDone(collideRun, 'orchestrator', GOOD);
  const beforeName = spawnNameFor(collideRun, 'n1');
  markRequested(collideRun, ['n1']);
  const freshName = regenerateSpawnName(collideRun, 'n1');
  ok('换名与旧名不同', freshName !== beforeName, `${beforeName} vs ${freshName}`);
  eq('换名后 spawnNameFor 返回新名', spawnNameFor(collideRun, 'n1'), freshName);
  eq('换名后 requested 清空', collideRun.requested.size, 0);
  eq('换名后又能派发', toDispatch(collideRun).map((n) => n.id), ['n1']);
  eq('不存在的节点换名返回空', regenerateSpawnName(collideRun, 'nope'), '');

  // 落盘 / 恢复：重启后能从断点续跑，且不会沿用旧 teammate 名
  const savedRun = makeRun(simpleNodes(), { runIndex: 3 });
  markDone(savedRun, 'orchestrator', GOOD);
  markRequested(savedRun, ['n1']);
  const savedName = spawnNameFor(savedRun, 'n1');
  const restored = deserializeRun(JSON.parse(JSON.stringify(serializeRun(savedRun))));
  ok('恢复出的 run 可用', Boolean(restored) && isActive(restored));
  eq('恢复后已完成节点还在', [...restored.status].filter(([, s]) => s === 'done').map(([id]) => id), ['orchestrator']);
  eq('恢复后清空 requested', restored.requested.size, 0);
  eq('恢复后清空 spawned', restored.spawned.size, 0);
  ok('恢复后换了新 token', restored.token !== savedRun.token, `${savedRun.token} vs ${restored.token}`);
  ok('恢复后 teammate 名换新', spawnNameFor(restored, 'n1') !== savedName);
  eq('恢复后仍能继续派发', toDispatch(restored).map((n) => n.id), ['n1']);
  eq('坏数据返回 null', deserializeRun({ rootId: 'x' }), null);
  eq('空 run 不序列化', serializeRun(null), null);

  // 画布上配的模型/技能/工具要进派发提示；跳过的 MCP 节点要说明，不能静默丢
  const configRun = makeRun([
    node('orchestrator', { label: '调度', type: 'orchestrator', task: '入口' }),
    node('worker', {
      label: '干活',
      task: '写代码',
      model: 'deepseek-v4-pro',
      provider: 'deepseek-official',
      reasoningEffort: 'high',
      skills: ['frontend-design'],
      tools: ['bash', 'edit'],
    }),
    node('mcp-node', { label: '查库', task: '', type: 'mcp', tool: 'db.query' }),
  ]);
  markDone(configRun, 'orchestrator', GOOD);
  const configDispatch = dispatchInstruction(configRun);
  ok('派发提示带上模型配置', configDispatch.includes('deepseek-official/deepseek-v4-pro'), configDispatch.slice(0, 200));
  ok('派发提示带上推理档', configDispatch.includes('推理 high'));
  ok('派发提示带上技能与工具', configDispatch.includes('frontend-design') && configDispatch.includes('bash'));
  ok('跳过的 MCP 节点有说明', configDispatch.includes('MCP 节点'), configDispatch.slice(-200));
}

function testLayeringAndSkip() {
  console.log('\n▶ 分层推进 / 无任务节点自动跳过');

  const run = makeRun([
    node('orchestrator', { label: '调度', task: '分任务' }),
    node('n1', { label: '拆需求', task: '拆任务', upstream: ['orchestrator'] }),
    node('placeholder', { label: '占位卡', task: '', upstream: ['orchestrator'] }),
    node('n2', { label: '评审', task: '评审', upstream: ['n1', 'placeholder'] }),
    node('n3', { label: '汇总', task: '汇总', upstream: ['n1'] }),
  ]);

  eq('占位节点直接 skipped', run.status.get('placeholder'), 'skipped');
  markDone(run, 'orchestrator', GOOD);
  eq('第一层只派 n1（占位跳过、n2/n3 等上游）', toDispatch(run).map((item) => item.id), ['n1']);

  ok('前置未完成不能标记', markDone(run, 'n2', GOOD).ok === false);
  ok('前置未完成给出原因', String(markDone(run, 'n2', GOOD).reason).includes('前置还没完成'));
  ok('跳过节点不能标记', String(markDone(run, 'placeholder', GOOD).reason).includes('没有任务'));

  spawn(run, 'n1');
  markDone(run, 'n1', GOOD);
  eq('第二层同时派 n2 与 n3', toDispatch(run).map((item) => item.id).sort(), ['n2', 'n3']);

  spawn(run, 'n2');
  spawn(run, 'n3');
  eq('派发后不重复', toDispatch(run), []);
  const finish = markDone(run, 'n2', GOOD);
  eq('还有 n3 没完成 → running', finish.state, 'running');
  eq('最后一个（n3）收束', markDone(run, 'n3', GOOD).state, 'done');
  eq('跳过节点不计入总数', statusLine(run), '画布「测试画布」：4/4 完成');
}

function testIllegalCompletions() {
  console.log('\n▶ 非法完成');

  const run = makeRun(simpleNodes());
  ok('未知节点被拒', String(markDone(run, 'ghost', GOOD).reason).includes('没有节点'));
  ok('缺 nodeId 被拒', String(markDone(run, undefined, GOOD).reason).includes('没有节点'));

  const layered = makeRun([
    node('orchestrator', { task: '分任务' }),
    node('a', { task: 'a', upstream: ['orchestrator'] }),
    node('b', { task: 'b', upstream: ['a'] }),
  ]);
  markDone(layered, 'orchestrator', GOOD);
  ok('上游没完成先拒', String(markDone(layered, 'b', GOOD).reason).includes('前置还没完成'));

  // 非根节点：requested 但没 spawned 也不行
  markRequested(layered, ['a']);
  ok('只 requested 不能完成', String(markDone(layered, 'a', GOOD).reason).includes('还没派发过'));
  markSpawned(layered, 'a');
  markDone(layered, 'a', GOOD);
  ok('重复标记被拒', String(markDone(layered, 'a', GOOD).reason).includes('已经完成过'));
}

function testStuck() {
  console.log('\n▶ 成环 → 卡住');

  const run = makeRun([
    node('orchestrator', { label: '调度', task: '分任务' }),
    node('a', { task: 'a', upstream: ['orchestrator', 'b'] }),
    node('b', { task: 'b', upstream: ['a'] }),
  ]);

  const result = markDone(run, 'orchestrator', GOOD);
  eq('根节点完成但无可执行 → state=stuck', result.state, 'stuck');
  ok('卡住原因写进 run', String(run.stuck).includes('互相等待') || String(run.stuck).includes('成环'), run.stuck);
  eq('卡住后不再 active', isActive(run), false);

  const stuck = stuckInstruction(run);
  ok('卡住指令含画布名与原因', stuck.includes('画布「测试画布」') && stuck.includes('没有可执行'), stuck.slice(0, 100));
  ok('卡住后再调 node_done 被拒', String(markDone(run, 'a', GOOD).reason).includes('已卡住'));

  // 建 run 时就没有入口 → 直接 stuck（不是"没有 run"）
  const noRoot = makeRun([]);
  ok('无入口的 run 在建时 stuck', String(noRoot.stuck).includes('没有入口节点'), noRoot.stuck);
  ok('无入口时 node_done 被拒', String(markDone(noRoot, 'x', GOOD).reason).includes('已卡住'));
}

function testClips() {
  console.log('\n▶ 预算纪律：规则不被截断');

  const longSeed = makeRun(simpleNodes(), { seed: 'x'.repeat(20_000) });
  const start = startInstruction(longSeed);
  ok('长 seed 时规则仍在', start.includes('agentflow_node_done') && start.includes('只做这个节点'));
  ok('长 seed 时给出截断提示', start.includes('用户输入过长已截断'), start.slice(-120));
  ok('开局指令长度受控', start.length <= FLOW_LIMITS.MAX_INSTRUCTION + 200, String(start.length));

  const wide = makeRun([
    node('orchestrator', { task: 't'.repeat(5_000) }),
    node('n1', { task: 'u'.repeat(5_000), upstream: ['orchestrator'] }),
    node('n2', { task: 'v'.repeat(5_000), upstream: ['orchestrator'] }),
  ]);
  markDone(wide, 'orchestrator', GOOD);
  const dispatch = dispatchInstruction(wide);
  ok('长 task 时派发规则仍在', dispatch.includes('name 必须逐字使用') && dispatch.includes('spawn_teammate'));
  ok('派发指令长度受控', dispatch.length <= FLOW_LIMITS.MAX_INSTRUCTION + 400, String(dispatch.length));

  const big = 'y'.repeat(20_000);
  markDone(wide, 'n1', big);
  ok('单节点产出被截到 8000', (wide.outputs.get('n1') || '').length <= FLOW_LIMITS.MAX_OUTPUT);

  const summary = summaryInstruction(wide);
  ok('summary 截到上限', summary.length <= FLOW_LIMITS.MAX_INSTRUCTION);
}

function testOwnerAndSeedFields() {
  console.log('\n▶ run 元信息');

  const run = makeRun(simpleNodes(), { ownerId: 'agent-x', seed: '做点事', runIndex: 2 });
  eq('ownerId 记录发起者', run.ownerId, 'agent-x');
  eq('seed 记录用户原话', run.seed, '做点事');
  eq('boardId 记录画布', run.boardId, 'board-1');
  eq('boardName 记录画布名', run.boardName, '测试画布');
  eq('startedAt 用注入的 now', run.startedAt, 1000);
  eq('runIndex 记录第几次', run.runIndex, 2);
  eq('task 会 trim（空白任务算占位）', makeRun([node('o', { task: '  有任务  ' })]).nodes.get('o').task, '有任务');
}

function main() {
  testRootAndStart();
  testDispatchAndSpawn();
  testRunIndexNames();
  testLayeringAndSkip();
  testIllegalCompletions();
  testStuck();
  testClips();
  testOwnerAndSeedFields();

  console.log('\n──────────────────────────────');
  console.log(`结果：通过 ${report.passed} · 失败 ${report.failed}`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const failure of failures) console.log('  - ' + failure);
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
}

main();
