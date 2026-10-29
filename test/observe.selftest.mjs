/**
 * lib/observe.js 的本地自测（不依赖真实 DSH）。
 *
 * 用一个假的 ctx（只实现 ctx.on）把观察器挂上，然后按真实 DSH 的调用约定
 * 触发三个钩子，断言：
 *   - 回调把下游结果原样返回（观察器绝不能改对话）
 *   - 事件形状对：step / tool / stop 三行、turn/step 归属正确
 *   - 被 deny 的调用也记成 isError
 *   - 超长参数被截断；agent id 里的路径字符不会逃出目录
 *   - dispose 之后不再写；flush 等得到在途写入
 *
 * 运行：node test/observe.selftest.mjs
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startObserver } from '../lib/observe.js';

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

/** 造一个只实现 ctx.on 的假上下文，按事件名取回调。 */
function fakeCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(event, listener) {
      handlers.set(event, listener);
      return () => handlers.delete(event);
    },
  };
}

function userMessage(text) {
  return { source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

function readLines(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentflow-observe-'));

  try {
    // ---- 挂上观察器 ------------------------------------------------------
    const ctx = fakeCtx();
    const observer = startObserver(ctx, { root });
    ok('四个钩子都挂上了', ctx.handlers.size === 4, [...ctx.handlers.keys()].join(','));

    // ---- pre-step：原样返回，并记一步 ------------------------------------
    const decision = { kind: 'enter', messages: [userMessage('你好')] };
    const passed = await ctx.handlers.get('agent/pre-step')(
      {
        agent: { id: 'sess-1' },
        messages: [userMessage('hi')],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => decision,
    );
    ok('pre-step 决策原样返回', passed === decision);

    // ---- 工具调用：归属到刚才那一步 --------------------------------------
    // 真实 DSH 契约：第二个参数才是工具结果（content/isError/error），
    // next() 返回的是管线决策对象（只有 kind）。
    const exec = { agent: { id: 'sess-1' }, name: 'spawn_teammate', arguments: { name: 'builder' } };
    const downstream = { kind: 'accept' };
    const toolPassed = await ctx.handlers.get('tools/post-execute')(
      exec,
      { isError: false, content: [{ type: 'text', text: '已派出 teammate builder' }] },
      async () => downstream,
    );
    ok('post-execute 决策原样返回', toolPassed === downstream);

    // ---- 被 deny 的调用也算一次（结果在第二个参数里） ----------------------
    await ctx.handlers.get('tools/post-execute')(
      { agent: { id: 'sess-1' }, name: 'team_task_update', arguments: { task_id: 't1' } },
      { isError: true, content: [{ type: 'text', text: 'Error: 不在当前节点' }] },
      async () => ({ kind: 'accept' }),
    );

    // ---- 决策对象不能被当成结果（回归：next() 的返回值只有 kind） ----------
    await ctx.handlers.get('tools/post-execute')(
      { agent: { id: 'sess-1' }, name: 'read', arguments: {} },
      { isError: false, content: [{ type: 'text', text: 'REAL-RESULT' }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: 'DECISION-NOT-RESULT' }] }),
    );

    // ---- turn-stopping ---------------------------------------------------
    ctx.handlers.get('agent/turn-stopping')({ agent: { id: 'sess-1' }, turn: 1 });

    // ---- 写入是异步的，flush 之后才落盘 ----------------------------------
    await observer.flush();
    const lines = readLines(await fs.readFile(path.join(root, 'sess-1.jsonl'), 'utf8'));
    eq('事件条数', lines.length, 5);
    eq(
      '事件类型顺序',
      lines.map((line) => line.t),
      ['step', 'tool', 'tool', 'tool', 'stop'],
    );

    const step = lines[0];
    eq('step 归属', { turn: step.turn, step: step.step }, { turn: 1, step: 1 });
    eq('step 输入摘要', step.msgs, [{ kind: 'user', form: undefined, chars: 2 }]);
    eq('step 决策类型', step.decision.kind, 'enter');
    eq('step 决策摘要', step.decision.msgs, [{ kind: 'user', form: undefined, chars: 2 }]);

    const tool = lines[1];
    eq('tool 名字', tool.name, 'spawn_teammate');
    eq('tool 参数', tool.args, '{"name":"builder"}');
    eq('tool 沿用当前步骤', { turn: tool.turn, step: tool.step }, { turn: 1, step: 1 });
    eq('tool 非错误', tool.isError, false);
    ok('tool 文本来自真实结果', tool.text.includes('已派出 teammate builder'), tool.text);

    const denied = lines[2];
    eq('deny 记成错误', denied.isError, true);
    ok('deny 文本保留原因', String(denied.text).includes('不在当前节点'), denied.text);

    const real = lines[3];
    ok('记录的是 _result 而不是决策', real.text.includes('REAL-RESULT'), real.text);
    ok('决策里的假结果不会被记录', !real.text.includes('DECISION-NOT-RESULT'), real.text);

    eq('stop 归属', { turn: lines[4].turn }, { turn: 1 });

    // ---- 超长参数截断 ----------------------------------------------------
    const longText = 'x'.repeat(1000);
    await ctx.handlers.get('tools/post-execute')(
      { agent: { id: 'sess-2' }, name: 'read', arguments: { file_path: longText } },
      { isError: false, content: [{ type: 'text', text: longText }] },
      async () => ({ kind: 'accept' }),
    );
    await observer.flush();
    const longLines = readLines(await fs.readFile(path.join(root, 'sess-2.jsonl'), 'utf8'));
    ok('参数被截断', longLines[0].args.length <= 301, String(longLines[0].args.length));
    ok('结果被截断', longLines[0].text.length <= 201, String(longLines[0].text.length));
    ok('截断补齐省略号', longLines[0].args.endsWith('…'));

    // ---- 非法 agent id 不逃出目录 ----------------------------------------
    await ctx.handlers.get('tools/post-execute')(
      { agent: { id: '../../etc/passwd' }, name: 'x', arguments: {} },
      { isError: false },
      async () => ({ kind: 'accept' }),
    );
    await observer.flush();
    const escaped = path.join(root, 'passwd.jsonl');
    const safe = await fs.access(escaped).then(() => true, () => false);
    ok('agent id 不会逃出目录', safe === false);
    const sanitized = await fs.readdir(root);
    ok(
      '被替换成安全文件名',
      sanitized.some((name) => name.includes('etc_passwd')),
      sanitized.join(','),
    );

    // ---- sink 抛错不影响对话 ---------------------------------------------
    const brokenCtx = fakeCtx();
    const broken = startObserver(brokenCtx, {
      root,
      sink: () => {
        throw new Error('boom');
      },
    });
    const brokenDecision = { kind: 'enter', messages: [] };
    const stillPassed = await brokenCtx.handlers.get('agent/pre-step')(
      { agent: { id: 'sess-3' }, messages: [], turn: 1, step: 1 },
      async () => brokenDecision,
    );
    ok('sink 抛错仍原样返回', stillPassed === brokenDecision);
    broken.dispose();

    // ---- 耗时来自 tools/execute（post-execute 的 next 量不到工具本身）----
    const slowCtx = fakeCtx();
    const slow = startObserver(slowCtx, { root });
    const slowExec = { agent: { id: 'sess-timing' }, name: 'bash', arguments: {}, token: 'tok-1' };
    await slowCtx.handlers.get('tools/execute')(slowExec, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { content: [] };
    });
    await slowCtx.handlers.get('tools/post-execute')(
      slowExec,
      { isError: false, content: [{ type: 'text', text: 'ok' }] },
      async () => ({ kind: 'accept' }),
    );
    await slow.flush();
    const timingLines = readLines(await fs.readFile(path.join(root, 'sess-timing.jsonl'), 'utf8'));
    ok('耗时取自真实执行（>=10ms）', timingLines[0].ms >= 10, String(timingLines[0].ms));
    slow.dispose();

    // ---- dispose 之后不再写 ----------------------------------------------
    observer.dispose();
    ok('dispose 摘掉监听', ctx.handlers.size === 0, [...ctx.handlers.keys()].join(','));
    await observer.flush();
    const before = readLines(await fs.readFile(path.join(root, 'sess-1.jsonl'), 'utf8')).length;
    eq('dispose 后没有新增', before, 5);
  } finally {
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
