// llm.mjs —— 模型调用。只走 DSH 内核的 llm bridge（docs/bridge-contract.md），
// 不保留任何直连 provider 的退路：bridge 连不上 = 「DSH 内核未连接」，节点直接失败。
//
// 一个节点可以挂两类东西：
//   - skills：把技能正文拼进 system prompt（提示层）
//   - tools ：把 MCP 工具交给模型做 function calling（执行层）
// 工具循环仍在本地：bridge 发 tool 事件 → 本地 mcpPool 执行 → 追加 assistant(tool-call)
// 与 tool 结果消息 → 再发一轮，直到模型给出最终回答或触达轮数上限。
// 这个循环只在节点内部，不影响整图调度。

import { composeSkillPrompt } from './skills.mjs';
import { bridgeStream, bridgeUnavailableReason } from './bridge.mjs';

const MOCK_DELAY_MS = 900;
const MAX_TOOL_ROUNDS = 6;

export function normalizeConfig(cfg) {
  const mock = cfg?.mock !== false; // 默认开 mock，关掉才真的连 bridge
  return {
    mock,
    mcpServers: cfg?.mcpServers || {},
    skillDirs: Array.isArray(cfg?.skillDirs) ? cfg.skillDirs : [],
    jev: cfg?.jev || {},
  };
}

/**
 * 节点上的 provider/model 直接交给 bridge。这里只做一件小事：
 * engine 的 fallback 会传 {...node, model: 'provider/model'}，把合并写法拆开；
 * 不查任何 provider 表 —— 能不能调由 DSH 内核决定。
 * @returns {{provider: string, model: string}}
 */
function targetOf(node) {
  const model = typeof node?.model === 'string' ? node.model.trim() : '';
  const provider = typeof node?.provider === 'string' ? node.provider.trim() : '';
  const slash = model.indexOf('/');
  if (slash > 0 && slash < model.length - 1) {
    return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
  }
  return { provider, model };
}

/**
 * 造一个 callLLM 给引擎用。
 * @param opts.bridgeDir bridge 发现文件所在目录（<dir>/data/dsh-bridge.json），省略用 bridge.mjs 默认
 * @param opts.mock      true = 离线假调用，不碰 bridge
 * @param opts.mcpPool   可选，提供 toolsFor(node.tools) 与 callTool(server, tool, args)
 * @param opts.onDelta   可选，默认流式回调 onDelta(chunk)；引擎会在每次调用时通过
 *                       callLLM(node, prompt, { onDelta }) 传一个带节点 id 的版本，优先生效
 */
export function makeCaller({ bridgeDir, mock, signal, mcpPool, skillDirs, onDelta }) {
  return async function callLLM(node, prompt, ctx = {}) {
    // 每次调用的回调优先（engine 用它把 chunk 绑到节点 id），否则用构造时的默认值；
    // node.onDelta 是兜底：上层包装没透传第三个参数时也能流式。
    const emitDelta =
      typeof ctx?.onDelta === 'function'
        ? ctx.onDelta
        : typeof onDelta === 'function'
          ? onDelta
          : typeof node?.onDelta === 'function'
            ? node.onDelta
            : undefined;

    const target = targetOf(node);
    // skill 正文拼进 system（每次现读，改文件即时生效）
    const skillPrompt = await composeSkillPrompt(node.skills, skillDirs).catch(() => '');

    if (mock) {
      return mockCall(node, prompt, target.provider || target.model || 'local', skillPrompt, emitDelta);
    }
    if (!target.model) {
      throw new Error('节点没有配置模型（模型调用只走 DSH 内核，先在节点上选一个模型）');
    }

    // bridge 没连上就别发请求：说清楚是哪一环断了（发现文件 / pid / health / token）
    const reason = await bridgeUnavailableReason(bridgeDir).catch(
      (err) => `bridge 健康检查失败：${String((err && err.message) || err)}`,
    );
    if (reason) throw new Error(`DSH 内核未连接（${reason}）`);

    // 挂载的 MCP 工具 → bridge 的 tools 定义
    const tools = collectTools(node, mcpPool);
    const system = buildSystem(skillPrompt);
    const messages = [{ role: 'user', content: prompt }];
    const usage = { promptTokens: 0, completionTokens: 0 };
    const requestHead = () => {
      const req = { provider: target.provider, model: target.model, system };
      // 推理强度：空 = 用模型自己的默认档，不发这个字段
      if (node.reasoningEffort) req.reasoningEffort = node.reasoningEffort;
      return req;
    };
    let content = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const turn = await runBridgeTurn(
        { ...requestHead(), messages, ...(tools.length ? { tools } : {}) },
        { dir: bridgeDir, signal, onDelta: emitDelta, usage },
      );
      if (!turn.calls.length) {
        content = turn.text.trim();
        break;
      }

      // 把模型的工具请求原样塞回历史，逐个在本地执行后追加 tool 结果
      messages.push({
        role: 'assistant',
        content: turn.calls.map((call) => ({
          type: 'tool-call',
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      });
      for (const call of turn.calls) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: await runToolCall(mcpPool, call.name, call.arguments),
        });
      }

      // 最后一轮如果还是工具调用，强制走一次收尾（不带工具，免得无限要工具）
      if (round === MAX_TOOL_ROUNDS - 1) {
        const finalTurn = await runBridgeTurn(
          { ...requestHead(), messages },
          { dir: bridgeDir, signal, onDelta: emitDelta, usage },
        );
        content = finalTurn.text.trim();
      }
    }

    return { content, usage };
  };
}

/**
 * 发一轮 /stream，收集本轮的全部事件。
 * @returns {Promise<{text: string, calls: Array<{id:string,name:string,arguments:string}>}>}
 */
async function runBridgeTurn(request, { dir, signal, onDelta, usage }) {
  const { events } = await bridgeStream(request, { dir: dir || undefined, signal });
  let text = '';
  const calls = [];

  for await (const evt of events) {
    if (!evt || typeof evt.type !== 'string') continue;
    if (evt.type === 'delta') {
      const chunk = typeof evt.text === 'string' ? evt.text : '';
      if (!chunk) continue;
      text += chunk;
      if (typeof onDelta === 'function') onDelta(chunk);
    } else if (evt.type === 'tool') {
      calls.push({
        id: String(evt.id || `call_${calls.length + 1}`),
        name: String(evt.name || ''),
        arguments:
          typeof evt.arguments === 'string' ? evt.arguments : JSON.stringify(evt.arguments ?? {}),
      });
    } else if (evt.type === 'usage') {
      usage.promptTokens += Number(evt.promptTokens) || 0;
      usage.completionTokens += Number(evt.completionTokens) || 0;
    }
  }

  return { text, calls };
}

function buildSystem(skillPrompt) {
  const base = '你是一个执行明确任务的助手。只输出任务要求的内容，不要寒暄。';
  return skillPrompt ? `${base}\n\n${skillPrompt}` : base;
}

/** 把节点挂的 `server.tool` 变成 bridge 的 tools 定义 */
function collectTools(node, mcpPool) {
  if (!mcpPool || !Array.isArray(node.tools) || !node.tools.length) return [];
  const out = [];
  for (const full of node.tools) {
    const dot = String(full).indexOf('.');
    if (dot < 0) continue;
    const server = full.slice(0, dot);
    const tool = full.slice(dot + 1);
    const def = mcpPool.toolDef(server, tool);
    if (!def) continue; // 工具不存在就跳过，不让整张卡炸掉
    out.push({
      name: fnName(server, tool),
      description: def.description || tool,
      parameters: def.inputSchema || { type: 'object', properties: {} },
    });
  }
  return out;
}

/** 工具名不允许点号，这里做映射 server.tool → server__tool */
function fnName(server, tool) {
  return String(server).replace(/[^\w-]/g, '_') + '__' + String(tool).replace(/[^\w-]/g, '_');
}

function parseFnName(name) {
  const i = name.indexOf('__');
  if (i < 0) return null;
  return { server: name.slice(0, i), tool: name.slice(i + 2) };
}

async function runToolCall(mcpPool, fnNameRaw, argsJson) {
  if (!mcpPool) return '错误：没有可用的 MCP 连接池';
  const parsed = parseFnName(fnNameRaw);
  if (!parsed) return `错误：函数名 ${fnNameRaw} 不合法`;
  let args = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return `错误：工具参数不是合法 JSON：${String(argsJson).slice(0, 200)}`;
  }
  try {
    const text = await mcpPool.callTool(parsed.server, parsed.tool, args);
    return String(text).slice(0, 20000); // 防止超长结果把上下文撑爆
  } catch (err) {
    return `工具执行失败：${err && err.message ? err.message : String(err)}`;
  }
}

/** 假调用：延迟一下，回一段能看出是 mock 的文字；有 onDelta 就按 ~40 字切块流出来。 */
async function mockCall(node, prompt, providerName, skillPrompt, onDelta) {
  await new Promise((r) => setTimeout(r, MOCK_DELAY_MS + Math.random() * 600));
  const head = (node.task || prompt || '').split('\n')[0].slice(0, 40);
  const lines = [
    `【mock · ${providerName}】${head}`,
    '',
    '（这是假输出，没有真的调模型。原因：当前是 mock 模式）',
    '',
    `收到材料 ${prompt.length} 字。真实调用后，这里会是模型返回的内容。`,
  ];
  if (skillPrompt) lines.push('', `已挂载技能：${(node.skills || []).join('、')}`);
  if (node.tools && node.tools.length) {
    lines.push(`已挂载工具：${node.tools.join('、')}（mock 模式下不会真的执行）`);
  }
  const content = lines.join('\n');

  // mock 也走一遍「打字机」：不传 onDelta 时保持原来的一次性返回
  if (typeof onDelta === 'function') {
    const size = 40;
    for (let i = 0; i < content.length; i += size) {
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 30));
      onDelta(content.slice(i, i + size));
    }
  }

  return {
    content,
    usage: { promptTokens: Math.ceil(prompt.length / 2), completionTokens: 60 },
  };
}
