/**
 * 把观察器的 jsonl 读成人能看的时间线。
 *
 * 用途：阶段 1 的「看清模型实际怎么调工具」——跑完几次真实对话后，
 * 用它看每一步进了什么、调了哪个工具、有没有被拒、在哪里收工。
 *
 * 用法：
 *   node scripts/observe-report.mjs              # 默认 ~/.dsh/agent-flow-data/observe
 *   node scripts/observe-report.mjs <dir>        # 指定目录
 *   node scripts/observe-report.mjs <dir> --tool spawn_teammate   # 只看某个工具
 *
 * 只读，不改任何文件。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'agent-flow-data', 'observe');

/** 参数：第一个非 -- 开头的是目录，--tool 过滤工具名。 */
function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  let only = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tool') {
      only = argv[i + 1] ?? null;
      i += 1;
    } else if (!arg.startsWith('--')) {
      root = path.resolve(arg);
    }
  }
  return { root, only };
}

function readEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* 半行（进程被杀时）直接跳过 */
    }
  }
  return events;
}

function ms(value) {
  return typeof value === 'number' ? `${value}ms` : '?';
}

/** 一条 tool 事件压成一行。 */
function toolLine(event) {
  const mark = event.isError ? '✗' : '✓';
  return `      ${mark} ${event.name} ${event.args ?? ''}  ${ms(event.ms)}${event.isError && event.text ? `  ← ${event.text}` : ''}`;
}

function report(file, events, only) {
  const tools = events.filter((event) => event.t === 'tool');
  const steps = events.filter((event) => event.t === 'step');
  const stops = events.filter((event) => event.t === 'stop');
  const denied = tools.filter((event) => event.isError).length;
  console.log(
    `\n${path.basename(file, '.jsonl')}  ·  turn ${stops.length} · step ${steps.length} · 工具 ${tools.length} · 失败 ${denied}`,
  );

  // 按 turn → step 归组；工具调用挂在它当时所在的 step 上
  const byTurn = new Map();
  for (const event of events) {
    const turn = event.turn ?? 0;
    if (!byTurn.has(turn)) byTurn.set(turn, { steps: new Map(), stops: [] });
    const bucket = byTurn.get(turn);
    if (event.t === 'step') bucket.steps.set(event.step, { step: event, tools: [] });
    if (event.t === 'tool') {
      const spot = bucket.steps.get(event.step);
      if (spot) spot.tools.push(event);
      else bucket.steps.set(event.step ?? 0, { step: null, tools: [event] });
    }
    if (event.t === 'stop') bucket.stops.push(event);
  }

  for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
    const bucket = byTurn.get(turn);
    console.log(`  turn ${turn}`);
    for (const stepNo of [...bucket.steps.keys()].sort((a, b) => a - b)) {
      const { step, tools: stepTools } = bucket.steps.get(stepNo);
      const incoming = step ? step.msgs.map((m) => `${m.kind}(${m.chars})`).join(' ') : '';
      const verdict = step ? (step.decision.kind === 'reject' ? 'reject' : step.decision.kind) : '?';
      console.log(`    step ${stepNo}  ${incoming || '(无输入)'} → ${verdict}`);
      for (const event of stepTools) {
        if (only && event.name !== only) continue;
        console.log(toolLine(event));
      }
    }
    if (bucket.stops.length) console.log('    ── 收工');
  }

  // 频次：一眼看出谁在刷工具
  const tally = new Map();
  for (const event of tools) tally.set(event.name, (tally.get(event.name) ?? 0) + 1);
  if (tally.size) {
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}×${count}`);
    console.log(`  工具频次：${top.join('  ')}`);
  }
}

async function main() {
  const { root, only } = parseArgs(process.argv.slice(2));
  const files = await fs.readdir(root).catch((err) => {
    if (err && err.code === 'ENOENT') {
      console.log(`没有观察数据：${root}\n（先跑几次对话，或者确认插件配置里 observe 没被关掉）`);
      return [];
    }
    throw err;
  });
  const jsonl = files.filter((name) => name.endsWith('.jsonl')).sort();
  if (jsonl.length === 0) return;

  for (const name of jsonl) {
    const text = await fs.readFile(path.join(root, name), 'utf8');
    report(path.join(root, name), readEvents(text), only);
  }
}

main().catch((err) => {
  console.error('读观察数据失败：', err);
  process.exitCode = 1;
});
