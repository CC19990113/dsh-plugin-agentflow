/**
 * lib/commands.js 的本地自测（不依赖真实 DSH）。
 *
 * 用一个假的 ctx（inject → 假 commands.register + 事件钩子）把命令热注册挂上，
 * 用临时数据目录造命令文件、boards.json、画布文件，断言：
 *   - 注册数量/名字/描述/input hint 正确
 *   - 画布缺失、命令文件损坏、命令名非法都跳过（只 warn）
 *   - handler 三种输入：空（只看画布）/ 文本（按画布 DAG 开 run + steer 开局指令）/ off（退模式）
 *   - 三个钩子：pre-step 追加提示、turn-stopping 催 node_done/催派发、pre-execute 拦非本层 spawn
 *   - agentflow_node_done：owner 校验、非法节点、状态行与 summary
 *   - fs.watch 热更新：新增 / 删除 / 描述变化都会 diff 注册表
 *   - dispose 注销全部命令、摘钩子并停掉 watcher（之后写文件不再注册）
 *   - 纯函数：容错归一幅画布、截断、命令记录校验
 *
 * 运行：node test/commands.selftest.mjs
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  startCommands,
  createNodeDoneTool,
  clipText,
  normalizeCommandRecord,
  normalizeBoard,
  buildBoardSummary,
  buildCanvasText,
  isCommandName,
} from '../lib/commands.js';
import { FLOW_LIMITS, spawnNameFor } from '../lib/flow.js';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// 假 ctx / 文件工具
// ---------------------------------------------------------------------------

function fakeCtx() {
  const registered = new Map();
  const calls = { inject: [] };
  const hooks = new Map();
  const fiber = { disposed: false, dispose() { this.disposed = true; } };

  const commands = {
    register(definition) {
      if (registered.has(definition.name)) throw new Error('duplicate ' + definition.name);
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  };

  const interrupted = [];
  const agentTeams = {
    interrupt(_agent, target) {
      interrupted.push(target);
    },
  };

  // 真实 cordis 的 inject child 同时带 commands / on / effect / inject
  const child = {
    commands,
    inject(deps, callback) {
      calls.inject.push(deps);
      const teamChild = { agentTeams, effect() { return () => {}; } };
      callback(teamChild);
      return fiber;
    },
    on(event, listener) {
      hooks.set(event, listener);
      return () => {
        if (hooks.get(event) === listener) hooks.delete(event);
      };
    },
    effect() {
      return () => {};
    },
  };

  const ctx = {
    commands,
    inject(deps, callback) {
      calls.inject.push(deps);
      callback(child);
      return fiber;
    },
  };

  return { ctx, registered, calls, fiber, hooks, interrupted };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

function userMessageText(message) {
  const block = Array.isArray(message?.content) ? message.content[0] : null;
  return block && typeof block.text === 'string' ? block.text : '';
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

function testPureFunctions() {
  console.log('\n▶ 纯函数：截断 / 容错读取 / 摘要');

  eq('截断不超过上限', clipText('x'.repeat(10), 5).length, 5);
  ok('截断末尾是省略号', clipText('x'.repeat(10), 5).endsWith('…'));
  eq('不超长时不改文本', clipText('短文本', 100), '短文本');

  ok('合法命令名', isCommandName('agentflow-review') && isCommandName('agentflow_x2'));
  ok('非法命令名', !isCommandName('Agentflow') && !isCommandName('-x') && !isCommandName(''));
  ok('名字 48 字符合法', isCommandName(`a${'b'.repeat(47)}`));
  ok('名字 49 字符非法（与引擎对齐）', !isCommandName(`a${'b'.repeat(48)}`));

  eq(
    '命令记录：name 缺失用文件名兜底',
    normalizeCommandRecord({ board: 'b1' }, 'agentflow-x'),
    { version: 1, name: 'agentflow-x', board: 'b1', createdAt: 0 },
  );
  eq('命令记录：名字非法返回 null', normalizeCommandRecord({ name: 'BadName', board: 'b1' }), null);
  eq('命令记录：没有画布返回 null', normalizeCommandRecord({ name: 'agentflow-x' }), null);
  eq('命令记录：不是对象返回 null', normalizeCommandRecord('oops', 'agentflow-x'), null);

  const board = normalizeBoard({
    id: 'b1',
    name: '需求评审',
    nodes: [
      { id: 'n1', label: '拆需求', task: '拆成任务', model: 'ds', type: 'orchestrator' },
      { id: 'n2', label: '评审', task: '按\n清单评审', criteria: '通过为止', verify: '应被忽略' },
      { label: '无 id 节点' },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  });
  eq('画布节点数', board.nodes.length, 3);
  eq('edges 反推上游', board.nodes[1].upstream, ['n1']);
  eq('无 id 节点补 id', board.nodes[2].id, 'n3');
  eq('criteria 只认 criteria', board.nodes[1].criteria, '通过为止');
  eq('type 透传（调度卡标记）', board.nodes[0].type, 'orchestrator');
  eq('verify 不回退成 criteria', normalizeBoard({ nodes: [{ id: 'x', verify: 'self' }] }).nodes[0].criteria, '');
  eq('空画布容错', normalizeBoard(null).nodes, []);
  eq('空画布名', normalizeBoard(null).name, '(未命名画布)');

  const summary = buildBoardSummary(board);
  ok('摘要含画布名', summary.includes('需求评审'));
  ok('摘要含任务', summary.includes('拆成任务'));
  ok('摘要含上游', summary.includes('上游：n1'));

  const canvasText = buildCanvasText('agentflow-x', board);
  ok('看画布文本含用法', canvasText.includes('/agentflow-x <要做的事>') && canvasText.includes('off'));
  ok('看画布文本不超过 4000', canvasText.length <= 4000);
}

// ---------------------------------------------------------------------------
// 热注册主流程
// ---------------------------------------------------------------------------

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentflow-commands-'));
  const dataDir = path.join(root, 'data');

  // 测试里预期会有坏文件 warn：收集起来，最后一起看，别刷屏
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((value) => String(value)).join(' '));
  };

  let api = null;
  try {
    testPureFunctions();

    // ---- 造数据：两张画布、一个有效命令、一个幽灵画布命令、一个坏文件、一个非法名字 ----
    await writeJson(path.join(dataDir, 'boards.json'), {
      order: ['b1', 'b2'],
      boards: {
        b1: { id: 'b1', name: '需求评审', createdAt: 1, updatedAt: 1 },
        b2: { id: 'b2', name: '发布检查', createdAt: 2, updatedAt: 2 },
      },
    });
    await writeJson(path.join(dataDir, 'boards', 'b1.json'), {
      id: 'b1',
      name: '需求评审',
      nodes: [
        { id: 'n1', label: '拆需求', task: '把需求拆成可执行任务', model: 'deepseek-flash' },
        { id: 'n2', label: '评审产出', task: '按\n清单评审', criteria: '通过为止' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    });
    await writeJson(path.join(dataDir, 'boards', 'b2.json'), {
      id: 'b2',
      name: '发布检查',
      nodes: [{ id: 'p1', label: '检查发布项', task: '逐项确认' }],
      edges: [],
    });

    const commandsDir = path.join(dataDir, 'commands');
    await writeJson(path.join(commandsDir, 'agentflow-review.json'), {
      version: 1,
      name: 'agentflow-review',
      board: 'b1',
      createdAt: 1,
    });
    await writeJson(path.join(commandsDir, 'agentflow-ghost.json'), {
      version: 1,
      name: 'agentflow-ghost',
      board: 'b-gone',
      createdAt: 2,
    });
    await fs.writeFile(path.join(commandsDir, 'broken.json'), '{oops', 'utf8');
    await writeJson(path.join(commandsDir, 'agentflow-bad.json'), {
      version: 1,
      name: 'BadName',
      board: 'b1',
      createdAt: 3,
    });

    // ---- 启动：假 ctx.inject 同步回调 ----
    console.log('\n▶ 启动与首次扫描');
    const fake = fakeCtx();
    api = startCommands(fake.ctx, { dir: path.join(root, 'runtime'), dataDir });
    await api.ready;

    eq('inject 依赖 commands 与可选的 agentTeams', fake.calls.inject, [['commands'], ['agentTeams']]);
    eq('注册数量（只注册有效命令）', fake.registered.size, 1);
    ok('注册了 agentflow-review', fake.registered.has('agentflow-review'));

    const review = fake.registered.get('agentflow-review');
    eq('描述 = 进入「画布名」工作流', review?.description, '进入「需求评审」工作流');
    eq('input hint', review?.input?.hint, '[off|要做的事] 默认只看画布');
    ok('画布缺失的命令跳过', !fake.registered.has('agentflow-ghost'));
    ok('非法命令名跳过', !fake.registered.has('agentflow-bad'));
    ok(
      '损坏命令文件只 warn',
      warnings.some((line) => line.includes('命令文件损坏') && line.includes('broken.json')),
      warnings.join(' | '),
    );

    // ---- handler：空输入只看画布 ----
    console.log('\n▶ handler：空输入');
    const steers = [];
    const agent = {
      id: 'agent-1',
      steer(message) {
        steers.push(message);
      },
    };
    const empty = await review.handler({ agent, rawInput: '   ', attachments: [], signal: new AbortController().signal });
    eq('空输入 kind=success', empty.kind, 'success');
    ok('空输入含画布名', empty.text.includes('需求评审'));
    ok('空输入含节点 id 与 label', empty.text.includes('n1「拆需求」') && empty.text.includes('n2「评审产出」'));
    ok('空输入含任务摘要', empty.text.includes('把需求拆成可执行任务'));
    ok('空输入含上游（含无上游）', empty.text.includes('上游：无') && empty.text.includes('上游：n1'));
    ok('空输入含用法', empty.text.includes('/agentflow-review <要做的事>'));
    eq('空输入不 steer', steers.length, 0);
    eq('空输入不记模式', api.modes.size, 0);

    // ---- handler：文本输入 = 按画布 DAG 开 run，steer 开局指令 ----
    console.log('\n▶ handler：文本输入（进入画布）');
    const reply = await review.handler({
      agent,
      rawInput: '  帮我把需求跑一遍  ',
      attachments: [],
      signal: new AbortController().signal,
    });
    eq('文本输入 kind=success', reply.kind, 'success');
    eq('进入画布文案', reply.text, '已进入画布「需求评审」，根节点开始');
    eq('steer 恰好一次（开局指令）', steers.length, 1);

    const message = steers[0];
    eq('消息角色 user', message.role, 'user');
    eq('消息来源 user', message.source.kind, 'user');
    const startText = userMessageText(message);
    ok('开局指令含画布名', startText.includes('画布「需求评审」开始'));
    ok('开局指令含用户原话', startText.includes('帮我把需求跑一遍'));
    ok('开局指令指明根节点 n1', startText.includes('入口节点 n1'));
    ok('开局指令要求调 node_done', startText.includes('agentflow_node_done') && startText.includes('node_id="n1"'));

    const run = api.modes.get('agent-1');
    ok('模式里存的是 run 对象', Boolean(run) && typeof run === 'object');
    eq('run 记的画布', run?.boardId, 'b1');
    eq('run 的根节点', run?.rootId, 'n1');
    eq('run 的 owner', run?.ownerId, 'agent-1');
    eq('run 的 seed', run?.seed, '帮我把需求跑一遍');

    // 进入模式后，空输入仍然只看画布、不 steer
    const afterEnter = await review.handler({ agent, rawInput: '', attachments: [] });
    eq('进模式后空输入仍 success', afterEnter.kind, 'success');
    eq('进模式后空输入不 steer', steers.length, 1);

    // 已有 active run 时再发文本：必须报错，不能静默覆盖
    const second = await review.handler({ agent, rawInput: '再跑一遍', attachments: [] });
    eq('已有 active run 时再开 → error', second.kind, 'error');
    ok('二次命令提示先 off', second.text.includes('已有进行中的画布工作流') && second.text.includes('off'), second.text);
    eq('二次命令不覆盖 run', api.modes.get('agent-1'), run);
    eq('二次命令不追加 steer', steers.length, 1);

    const bigSteers = [];
    const bigAgent = { id: 'agent-big', steer: (msg) => bigSteers.push(msg) };
    const bigReply = await review.handler({
      agent: bigAgent,
      rawInput: 'x'.repeat(20000),
      attachments: [],
      signal: new AbortController().signal,
    });
    eq('超长输入仍 success', bigReply.kind, 'success');
    ok(
      '开局指令总长截到 flow 上限',
      userMessageText(bigSteers[0]).length <= FLOW_LIMITS.MAX_INSTRUCTION,
      String(userMessageText(bigSteers[0]).length),
    );

    // ---- 落盘：进行中的 run 应该有文件 ----
    await new Promise((resolve) => setTimeout(resolve, 60)); // persistRun 是 fire-and-forget
    const runFile = path.join(dataDir, 'runs', 'agent-1.json');
    const runFileExists = await fs.readFile(runFile, 'utf8').then(() => true, () => false);
    ok('进行中的 run 已落盘', runFileExists, runFile);

    // ---- handler：off 退出 ----
    console.log('\n▶ handler：off');
    const off = await review.handler({ agent, rawInput: ' off ', attachments: [], signal: new AbortController().signal });
    eq('off kind=success', off.kind, 'success');
    eq('off 文案', off.text, '已退出「需求评审」工作流');
    eq('off 清掉 run', api.modes.has('agent-1'), false);
    await new Promise((resolve) => setTimeout(resolve, 60)); // 删除也是 fire-and-forget
    const runFileGone = await fs.access(runFile).then(() => false, () => true);
    ok('off 后落盘文件被删', runFileGone, runFile);

    // ---- 宿主没有 steer 时返回 error 而不是 throw ----
    const noSteer = await review.handler({ agent: { id: 'agent-2' }, rawInput: '做点事', attachments: [] });
    eq('缺 steer 返回 error', noSteer.kind, 'error');
    eq('缺 steer 不记模式', api.modes.has('agent-2'), false);

    // ---- 历史遗留：modes 里的字符串只当"记过画布"，钩子不碰 ----
    api.modes.set('legacy-agent', 'b1');
    const legacyDecision = { kind: 'enter', messages: [] };
    eq(
      '旧字符串模式不注入 pre-step',
      await fake.hooks.get('agent/pre-step')({ agent: { id: 'legacy-agent' } }, async () => legacyDecision),
      legacyDecision,
    );
    const legacySteers = [];
    fake.hooks.get('agent/turn-stopping')({
      agent: { id: 'legacy-agent', steer: (msg) => legacySteers.push(msg) },
      turn: 1,
    });
    eq('旧字符串模式不催派发', legacySteers.length, 0);
    api.modes.delete('legacy-agent');

    // ---- 钩子 + node_done 工具：一条完整的小工作流 ----
    console.log('\n▶ 工作流钩子（pre-step / turn-stopping / pre-execute / post-execute）');
    eq(
      '四个钩子都挂在 inject child 上',
      [...fake.hooks.keys()].sort(),
      ['agent/pre-step', 'agent/turn-stopping', 'tools/post-execute', 'tools/pre-execute'],
    );

    const hookSteers = [];
    const hookAgent = { id: 'hook-agent', steer: (msg) => hookSteers.push(msg) };
    await review.handler({ agent: hookAgent, rawInput: '按画布跑一遍', attachments: [] });
    eq('进入画布产生一条开局指令', hookSteers.length, 1);
    const hookRun = api.modes.get('hook-agent');
    eq('hook run 根节点 n1', hookRun?.rootId, 'n1');
    eq('首个 run 的 runIndex=1', hookRun?.runIndex, 1);

    // pre-step：enter 分支追加一条提示，reject 原样返回
    const baseDecision = { kind: 'enter', messages: [{ id: 'm1' }] };
    const injected = await fake.hooks.get('agent/pre-step')(
      { agent: hookAgent, messages: [], turn: 1, step: 1 },
      async () => baseDecision,
    );
    ok('pre-step 返回新 decision', injected !== baseDecision);
    eq('pre-step 只追加一条', injected.messages.length, 2);
    eq('pre-step 保留原有消息', injected.messages[0], { id: 'm1' });
    ok('pre-step 追加的是画布提示', userMessageText(injected.messages[1]).includes('进行中'));
    ok('pre-step 提示要求 node_done', userMessageText(injected.messages[1]).includes('agentflow_node_done'));

    // 状态没变不该重复注入（长流程每一步都塞同样提示是白烧 token）
    const sameState = await fake.hooks.get('agent/pre-step')(
      { agent: hookAgent, messages: [], turn: 2, step: 3 },
      async () => ({ kind: 'enter', messages: [{ id: 'm2' }] }),
    );
    eq('状态没变不重复注入', sameState.messages.length, 1);

    const rejectDecision = { kind: 'reject' };
    eq(
      'pre-step reject 原样返回',
      await fake.hooks.get('agent/pre-step')({ agent: hookAgent }, async () => rejectDecision),
      rejectDecision,
    );
    const otherDecision = { kind: 'enter', messages: [] };
    eq(
      'pre-step 对没有 run 的 agent 不注入',
      await fake.hooks.get('agent/pre-step')({ agent: { id: 'other-agent' } }, async () => otherDecision),
      otherDecision,
    );

    // turn-stopping：根节点没完成 → 催 node_done，同一 turn 只催一次
    fake.hooks.get('agent/turn-stopping')({ agent: hookAgent, turn: 1 });
    eq('根节点未完成时催一次', hookSteers.length, 2);
    ok(
      '催促文案含根节点与工具调用',
      userMessageText(hookSteers[1]).includes('根节点 n1 还没完成') &&
        userMessageText(hookSteers[1]).includes('agentflow_node_done'),
    );
    fake.hooks.get('agent/turn-stopping')({ agent: hookAgent, turn: 1 });
    eq('同一 turn 不重复催', hookSteers.length, 2);
    fake.hooks.get('agent/turn-stopping')({ agent: hookAgent, turn: 2 });
    eq('下一个 turn 可以再催', hookSteers.length, 3);

    // node_done 工具：owner 校验 / 非法节点 / 成功
    const nodeDone = createNodeDoneTool((agentId) => api.getRun(agentId));
    ok('工具描述含硬要求', nodeDone.description.includes('完成当前画布节点必须调用，不调用视为未完成'));
    eq(
      '没有 run 的 agent 调工具 → 当前没有工作流',
      (await nodeDone.execute({ node_id: 'n1', output: 'x'.repeat(20) }, { agent: { id: 'stranger' } })).text.includes(
        '当前没有工作流',
      ),
      true,
    );
    const foreignTool = createNodeDoneTool(() => hookRun);
    ok(
      'owner 不符 → 明确拒绝',
      (
        await foreignTool.execute({ node_id: 'n1', output: 'x'.repeat(20) }, { agent: { id: 'intruder' } })
      ).text.includes('只有发起'),
    );
    ok(
      '前置没完成 → 不行',
      (
        await nodeDone.execute({ node_id: 'n2', output: 'n2 的实际产出内容足够长' }, { agent: hookAgent })
      ).text.includes('前置还没完成'),
    );
    ok(
      '产出太短 → 不行',
      (await nodeDone.execute({ node_id: 'n1', output: '完成' }, { agent: hookAgent })).text.includes('太短'),
    );
    const doneRoot = await nodeDone.execute(
      { node_id: 'n1', output: '根节点产出：需求拆成 3 项，给出验收清单。' },
      { agent: hookAgent },
    );
    ok('根节点完成返回状态行', doneRoot.text.includes('1/2 完成'), doneRoot.text);
    ok('根节点完成提示继续', doneRoot.text.includes('继续'), doneRoot.text);

    // turn-stopping：有可派发节点 → 催 spawn_teammate（名字走 spawnNameFor）并 markRequested
    const n2name = spawnNameFor(hookRun, 'n2');
    fake.hooks.get('agent/turn-stopping')({ agent: hookAgent, turn: 3 });
    eq('催派发一条', hookSteers.length, 4);
    ok(
      '派发文案含 spawn_teammate 与真实名字',
      userMessageText(hookSteers[3]).includes('spawn_teammate') &&
        userMessageText(hookSteers[3]).includes(`"${n2name}"（节点 n2）`),
      userMessageText(hookSteers[3]).slice(0, 200),
    );
    eq('n2 进入 requested', [...hookRun.requested], ['n2']);
    eq('requested 还不是 spawned', [...hookRun.spawned], []);
    fake.hooks.get('agent/turn-stopping')({ agent: hookAgent, turn: 4 });
    eq('下一个 turn 首次再催一次', hookSteers.length, 5);
    ok(
      '催促列出待 spawn 的名字',
      userMessageText(hookSteers[4]).includes('还没建 teammate') && userMessageText(hookSteers[4]).includes(n2name),
      userMessageText(hookSteers[4]).slice(0, 160),
    );
    fake.hooks.get('agent/turn-stopping')({ agent: hookAgent, turn: 4 });
    eq('同一个 turn 不重复催', hookSteers.length, 5);

    // 只是 requested（没观察到成功 spawn）时不允许完成该节点
    ok(
      '只 requested 时 node_done 被拒',
      (
        await nodeDone.execute({ node_id: 'n2', output: '内容足够长的实际产出正文' }, { agent: hookAgent })
      ).text.includes('还没派发过'),
    );

    // pre-execute：只允许请求过/已 spawn 的名字
    const nextSpy = () => ({ kind: 'allow' });
    const allowed = fake.hooks.get('tools/pre-execute')(
      { name: 'spawn_teammate', arguments: { name: n2name }, agent: hookAgent },
      nextSpy,
    );
    eq('requested 的名字放行', allowed.kind, 'allow');

    const denied = fake.hooks.get('tools/pre-execute')(
      { name: 'spawn_teammate', arguments: { name: 'n1' }, agent: hookAgent },
      nextSpy,
    );
    eq('非本层名字 deny', denied.kind, 'deny');
    ok(
      'deny 文案列出名字并说明节点 id 反查',
      String(denied.reason).includes('当前层只允许派发这些名字：n2') && String(denied.reason).includes('节点 id 反查'),
      denied.reason,
    );

    const deniedNoArgs = fake.hooks.get('tools/pre-execute')(
      { name: 'spawn_teammate', arguments: undefined, agent: hookAgent },
      nextSpy,
    );
    eq('arguments 缺失也 deny', deniedNoArgs.kind, 'deny');

    eq(
      '非 spawn_teammate 工具放行',
      fake.hooks.get('tools/pre-execute')({ name: 'read_file', arguments: {}, agent: hookAgent }, nextSpy).kind,
      'allow',
    );
    eq(
      '没有 run 的 agent 派发放行',
      fake.hooks.get('tools/pre-execute')(
        { name: 'spawn_teammate', arguments: { name: 'whatever' }, agent: { id: 'other-agent' } },
        nextSpy,
      ).kind,
      'allow',
    );

    // post-execute：第二个参数才是真实结果；只有成功 spawn_teammate 才 markSpawned
    console.log('\n▶ post-execute：真实 spawn 才放行 node_done');
    const postNextDecision = { kind: 'allow' };
    const postNext = () => postNextDecision;
    const postFailed = await fake.hooks.get('tools/post-execute')(
      { name: 'spawn_teammate', arguments: { name: n2name }, agent: hookAgent },
      { isError: true, content: [{ type: 'text', text: 'Error: name taken' }] },
      postNext,
    );
    eq('post-execute 原样返回决策', postFailed, postNextDecision);
    eq('失败的 spawn 不记 spawned', hookRun.spawned.size, 0);
    eq('失败的 spawn 仍 requested', [...hookRun.requested], ['n2']);

    await fake.hooks.get('tools/post-execute')(
      { name: 'spawn_teammate', arguments: { name: 'nope' }, agent: hookAgent },
      { isError: false, content: [] },
      postNext,
    );
    eq('命不中节点名的 spawn 忽略', hookRun.spawned.size, 0);

    await fake.hooks.get('tools/post-execute')(
      { name: 'spawn_teammate', arguments: { name: n2name }, agent: hookAgent },
      { isError: false, content: [{ type: 'text', text: `spawned teammate ${n2name}` }] },
      postNext,
    );
    eq('成功 spawn 记 spawned', [...hookRun.spawned], ['n2']);
    eq('spawn 后 requested 清空', hookRun.requested.size, 0);

    fake.hooks.get('agent/turn-stopping')({ agent: hookAgent, turn: 5 });
    eq('已派发待回报时不催', hookSteers.length, 5);

    // 撞名兜底：spawn 报 already used → 换名并催一次（用根节点，避免影响 n2 的完成校验）
    const beforeCollision = spawnNameFor(hookRun, 'n1');
    await fake.hooks.get('tools/post-execute')(
      { name: 'spawn_teammate', arguments: { name: beforeCollision }, agent: hookAgent },
      { isError: true, content: [{ type: 'text', text: 'Error: teammate name "x" was already used in this Team' }] },
      postNext,
    );
    const afterCollision = spawnNameFor(hookRun, 'n1');
    ok('撞名后自动换名', afterCollision !== beforeCollision, `${beforeCollision} vs ${afterCollision}`);
    ok(
      '撞名后催模型用新名',
      userMessageText(hookSteers[hookSteers.length - 1]).includes(afterCollision),
      userMessageText(hookSteers[hookSteers.length - 1]).slice(0, 160),
    );

    // 完成最后一个节点 → 全部完成；之后 turn-stopping 不再 steer
    const finished = await nodeDone.execute(
      { node_id: 'n2', output: '评审通过：全部验收项都满足，可以发布。' },
      { agent: hookAgent },
    );
    ok(
      '最后一个节点完成给出 summary',
      finished.text.includes('2/2 完成') && finished.text.includes('全部完成'),
      finished.text,
    );
    const steersBeforeDone = hookSteers.length;
    fake.hooks.get('agent/turn-stopping')({ agent: hookAgent, turn: 6 });
    eq('run 完成后不再 steer', hookSteers.length, steersBeforeDone);

    ok(
      '完成后工具说没有工作流',
      (await nodeDone.execute({ node_id: 'n1', output: 'x'.repeat(20) }, { agent: hookAgent })).text.includes(
        '当前没有工作流',
      ),
    );

    // ---- awaitingSpawn 超时提醒 ----
    console.log('\n▶ awaitingSpawn 超时提醒');
    const timeoutSteers = [];
    const timeoutAgent = { id: 'timeout-agent', steer: (msg) => timeoutSteers.push(msg) };
    await review.handler({ agent: timeoutAgent, rawInput: '再跑一张画布', attachments: [] });
    const timeoutRun = api.modes.get('timeout-agent');
    await nodeDone.execute({ node_id: 'n1', output: '入口节点产出：需求拆成 2 项。' }, { agent: timeoutAgent });
    fake.hooks.get('agent/turn-stopping')({ agent: timeoutAgent, turn: 1 });
    eq('先发派发指令', timeoutSteers.length, 2);
    eq('请求后进入 waiting', [...timeoutRun.requested], ['n2']);

    timeoutRun.lastAdvanceAt = Date.now() - 121_000;
    fake.hooks.get('agent/turn-stopping')({ agent: timeoutAgent, turn: 2 });
    eq('超时后补一条提醒', timeoutSteers.length, 3);
    const reminder = userMessageText(timeoutSteers[2]);
    ok(
      '提醒用名字并要求先 spawn',
      reminder.includes('还没建 teammate') && reminder.includes('n2') && reminder.includes('spawn_teammate'),
      reminder,
    );
    ok('提醒后重置 lastAdvanceAt', Date.now() - timeoutRun.lastAdvanceAt < 1000);
    fake.hooks.get('agent/turn-stopping')({ agent: timeoutAgent, turn: 3 });
    eq('下一个 turn 还会再提醒一次', timeoutSteers.length, 4);
    fake.hooks.get('agent/turn-stopping')({ agent: timeoutAgent, turn: 3 });
    eq('同一 turn 内不重复刷', timeoutSteers.length, 4);

    // ---- 第二次 run：roster 名字不复用（-r2 后缀）----
    console.log('\n▶ 第二次 run 的名字后缀');
    const r2Steers = [];
    const r2Agent = { id: 'r2-agent', steer: (msg) => r2Steers.push(msg) };
    await review.handler({ agent: r2Agent, rawInput: '第一次进入', attachments: [] });
    await review.handler({ agent: r2Agent, rawInput: ' off ', attachments: [] });
    const r2Reply = await review.handler({ agent: r2Agent, rawInput: '第二次进入', attachments: [] });
    eq('第二次进入成功', r2Reply.kind, 'success');
    const r2Run = api.modes.get('r2-agent');
    eq('runIndex 自增到 2', r2Run?.runIndex, 2);

    await nodeDone.execute({ node_id: 'n1', output: '入口节点产出：需求拆成 3 项。' }, { agent: r2Agent });
    fake.hooks.get('agent/turn-stopping')({ agent: r2Agent, turn: 1 });
    const r2Dispatch = userMessageText(r2Steers[r2Steers.length - 1]);
    const r2Name = spawnNameFor(r2Run, 'n2');
    ok('第二次 run 派发用带后缀的名字', r2Dispatch.includes(`"${r2Name}"（节点 n2）`), r2Dispatch.slice(0, 220));
    ok('第二次 run 的名字与第一次不同', r2Name !== n2name, `${n2name} vs ${r2Name}`);

    const r2Allow = fake.hooks.get('tools/pre-execute')(
      { name: 'spawn_teammate', arguments: { name: r2Name }, agent: r2Agent },
      nextSpy,
    );
    eq('第二次 run 的后缀名放行', r2Allow.kind, 'allow');
    const r2Deny = fake.hooks.get('tools/pre-execute')(
      { name: 'spawn_teammate', arguments: { name: 'n2' }, agent: r2Agent },
      nextSpy,
    );
    eq('裸节点 id 在第二次 run 被拒', r2Deny.kind, 'deny');
    ok('deny 文案给出真实名字', String(r2Deny.reason).includes(r2Name), r2Deny.reason);


    // ---- /off 顺手中断已派出的 teammate ----
    const offAgent = { id: 'off-agent', steer() {} };
    await review.handler({ agent: offAgent, rawInput: '开跑', attachments: [] });
    await nodeDone.execute({ node_id: 'n1', output: '入口产出：需求已确认，拆成三项。' }, { agent: offAgent });
    fake.hooks.get('agent/turn-stopping')({ agent: offAgent, turn: 1 });
    const offRun = api.getRun('off-agent');
    const spawnTarget = spawnNameFor(offRun, 'n2');
    await fake.hooks.get('tools/post-execute')(
      { name: 'spawn_teammate', arguments: { name: spawnTarget }, agent: offAgent },
      { isError: false, content: [{ type: 'text', text: 'ok' }] },
      async () => ({ kind: 'accept' }),
    );
    eq('spawn 成功记入 run', [...offRun.spawned], ['n2']);
    const offReply = await review.handler({ agent: offAgent, rawInput: 'off', attachments: [] });
    ok('off 文案说明中断了几个', String(offReply.text).includes('已中断 1 个 teammate'), offReply.text);
    eq('off 真的调了 interrupt', fake.interrupted, [spawnTarget]);

    // ---- 重启恢复：新 session 读同一个 dataDir，应恢复未完成的 run ----
    console.log('\n▶ 重启恢复');
    const resumeSteers = [];
    const resumeAgent = { id: 'resume-agent', steer: (msg) => resumeSteers.push(msg) };
    await review.handler({ agent: resumeAgent, rawInput: '跑到一半', attachments: [] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const resumeFile = path.join(dataDir, 'runs', 'resume-agent.json');
    ok('恢复用 run 已落盘', await fs.access(resumeFile).then(() => true, () => false), resumeFile);

    const fake2 = fakeCtx();
    const api2 = startCommands(fake2.ctx, { dir: path.join(root, 'runtime'), dataDir, pollMs: 60000 });
    await api2.ready;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const restoredRun = api2.getRun('resume-agent');
    ok('重启后恢复了 run', Boolean(restoredRun) && api2.modes.has('resume-agent'));
    eq('恢复的 run 清空了 spawned', restoredRun ? restoredRun.spawned.size : -1, 0);
    api2.dispose();

    // ---- 热更新：新增命令文件 ----
    console.log('\n▶ 热更新（fs.watch）');
    await writeJson(path.join(commandsDir, 'agentflow-release.json'), {
      version: 1,
      name: 'agentflow-release',
      board: 'b2',
      createdAt: 4,
    });
    ok(
      '新增命令热注册',
      await waitFor(() => fake.registered.has('agentflow-release')),
      [...fake.registered.keys()].join(','),
    );
    eq('新命令描述', fake.registered.get('agentflow-release')?.description, '进入「发布检查」工作流');

    // ---- 热更新：同一命令换画布 → 描述变化 → 先 dispose 旧的再注册 ----
    const beforeSwap = fake.registered.get('agentflow-review');
    await writeJson(path.join(commandsDir, 'agentflow-review.json'), {
      version: 1,
      name: 'agentflow-review',
      board: 'b2',
      createdAt: 1,
    });
    ok(
      '描述变化触发重注册',
      await waitFor(() => fake.registered.get('agentflow-review')?.description === '进入「发布检查」工作流'),
      fake.registered.get('agentflow-review')?.description,
    );
    ok('重注册换了新的定义对象', fake.registered.get('agentflow-review') !== beforeSwap);

    // ---- 热更新：删除命令文件 ----
    await fs.rm(path.join(commandsDir, 'agentflow-release.json'));
    ok(
      '删除命令热注销',
      await waitFor(() => !fake.registered.has('agentflow-release')),
      [...fake.registered.keys()].join(','),
    );

    // ---- 画布从 boards.json 消失：reload 后命令被注销 ----
    await writeJson(path.join(dataDir, 'boards.json'), {
      order: ['b1'],
      boards: { b1: { id: 'b1', name: '需求评审', createdAt: 1, updatedAt: 1 } },
    });
    await api.reload();
    eq('画布消失后剩余注册', fake.registered.size, 0);

    // ---- dispose：注销 + 停 watcher + 摘钩子 ----
    console.log('\n▶ dispose');
    api.dispose();
    eq('dispose 注销全部命令', fake.registered.size, 0);
    eq('dispose 摘掉四个钩子', fake.hooks.size, 0);
    ok('dispose 回收 inject fiber', fake.fiber.disposed === true);

    await writeJson(path.join(commandsDir, 'agentflow-after.json'), {
      version: 1,
      name: 'agentflow-after',
      board: 'b1',
      createdAt: 5,
    });
    await sleep(500);
    eq('dispose 后 watch 已停（不再注册）', fake.registered.size, 0);
  } finally {
    try {
      api?.dispose();
    } catch {}
    console.warn = originalWarn;
    await fs.rm(root, { recursive: true, force: true });
  }

  // =======================================================================
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

main().catch((err) => {
  console.error('测试脚本自身异常：', err);
  process.exitCode = 1;
});
