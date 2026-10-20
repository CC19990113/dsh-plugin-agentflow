/**
 * lib/bridge.js 的本地自测（不依赖真实 DSH）。
 *
 * 用一个假的 ctx.llm 起真的 HTTP 服务，然后按 docs/bridge-contract.md 断言：
 * 发现文件 / health / catalog / 401 / 403 / 404 / 413 / 429 / SSE 事件顺序 /
 * tool 累积 / usage 映射 / 中止 / 超时 / dispose。
 *
 * 运行：node test/bridge.selftest.mjs
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { startBridge, bridgeInfoPath } from '../lib/bridge.js';

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
// 假 ctx.llm
// ---------------------------------------------------------------------------

function createFakeLlm() {
  const calls = {
    listProviders: 0,
    listModels: 0,
    resolveModelInfo: 0,
    streams: [],
  };
  const flags = { failProviders: false };
  let extraModels = [];

  const providers = [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'broken-route', name: 'Broken Route' },
  ];

  let streamImpl = async function* () {
    yield { type: 'text-delta', index: 0, text: 'ok' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };

  const llm = {
    listProviders() {
      calls.listProviders += 1;
      if (flags.failProviders) throw new Error('mock listProviders boom');
      return providers.map((provider) => ({ ...provider }));
    },
    async listModels(provider) {
      calls.listModels += 1;
      if (provider === 'broken-route') throw new Error('mock listModels boom');
      return [
        { provider, id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
        { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { provider, id: 'plain-model', name: 'Plain' },
        ...extraModels.map((model) => ({ provider, ...model })),
      ];
    },
    async resolveModelInfo(provider, model) {
      calls.resolveModelInfo += 1;
      if (model === 'deepseek-flash') {
        return {
          provider,
          id: model,
          name: 'DeepSeek V4.1 Flash',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'high',
          },
        };
      }
      if (model === 'deepseek-v4-pro') {
        return {
          provider,
          id: model,
          name: 'DeepSeek V4 Pro',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'mid', name: 'Mid' },
              { id: 'max', name: 'Max' },
            ],
          },
        };
      }
      if (model === 'plain-model') return { provider, id: model, name: 'Plain' };
      if (model === 'weird-model') throw new Error('mock resolveModelInfo 炸了');
      throw new Error('mock resolveModelInfo 未知模型：' + model);
    },
    stream(options) {
      calls.streams.push(options);
      return streamImpl(options);
    },
  };

  return {
    llm,
    calls,
    flags,
    setStream(fn) {
      streamImpl = fn;
    },
    setExtraModels(models) {
      extraModels = models;
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs = 2000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseSse(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (!payload) continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // 坏行让断言自己发现
    }
  }
  return events;
}

async function jsonRequest(port, pathname, opts = {}) {
  const headers = {};
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, text, json: parseJson(text), headers: res.headers };
}

/** 用 node:http 发请求，方便自定义 Host 头、测试 chunked body。 */
function rawRequest(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: opts.host || `127.0.0.1:${port}` };
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, text, json: parseJson(text) }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function openStream(port, token, body, signal) {
  return fetch(`http://127.0.0.1:${port}/stream`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

async function streamEvents(port, token, body) {
  const res = await openStream(port, token, body);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, events: parseSse(text) };
}

async function waitForInfo(dir, timeoutMs = 3000) {
  const file = bridgeInfoPath(dir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const info = JSON.parse(raw);
      if (Number.isInteger(info.port) && info.port > 0) return { info, file, raw };
    } catch {}
    await sleep(20);
  }
  throw new Error('等不到发现文件：' + file);
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const SIMPLE_REQUEST = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: '你好' }],
};

const FULL_REQUEST = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
  system: '你是测试助手',
  messages: [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'srv__tool', arguments: '{"a":1}' }] },
    { role: 'tool', toolCallId: 'c1', content: '工具结果' },
  ],
  tools: [{ name: 'srv__tool', description: '测试工具', parameters: { type: 'object', properties: { a: { type: 'number' } } } }],
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentflow-bridge-test-'));
  const stops = [];
  let dummyBackend = null;

  try {
    // =====================================================================
    console.log('\n▶ 启动 bridge（port=0，假 ctx.llm）');
    const dirA = path.join(root, 'a');
    const fake = createFakeLlm();
    const stopA = startBridge({ llm: fake.llm }, { dir: dirA, port: 0, catalogTtlMs: 150, requestTimeoutMs: 5000 });
    stops.push(stopA);

    const { info, file } = await waitForInfo(dirA);
    const port = info.port;
    const token = info.token;

    // 发现文件
    eq('发现文件 version=1', info.version, 1);
    eq('发现文件 pid=当前进程', info.pid, process.pid);
    ok('发现文件 port 是正整数', Number.isInteger(info.port) && info.port > 0, `port=${info.port}`);
    ok('发现文件 token ≥32 个 URL 安全字符', typeof token === 'string' && token.length >= 32 && /^[A-Za-z0-9_-]+$/.test(token), `token=${String(token).slice(0, 8)}…`);
    ok('发现文件 startedAt 是数字', Number.isFinite(info.startedAt) && info.startedAt > 0);
    const stat = await fs.stat(file);
    eq('发现文件权限 0600', stat.mode & 0o777, 0o600);

    // =====================================================================
    console.log('\n▶ GET /health 与鉴权');
    const health = await jsonRequest(port, '/health', { token });
    eq('health 200', health.status, 200);
    eq('health body', health.json, { ok: true, pid: process.pid, providers: 2 });

    const noToken = await jsonRequest(port, '/health');
    eq('缺 token → 401', noToken.status, 401);
    eq('401 body', noToken.json, { error: 'unauthorized' });

    const wrongToken = await jsonRequest(port, '/health', { token: token + 'x' });
    eq('错 token → 401', wrongToken.status, 401);

    const badHost = await rawRequest(port, '/health', { token, host: `evil.example:${port}` });
    eq('非本机 Host → 403', badHost.status, 403);
    eq('403 body', badHost.json, { error: 'bad host' });

    const notFound = await jsonRequest(port, '/nope', { token });
    eq('未知路径 → 404', notFound.status, 404);
    eq('404 body', notFound.json, { error: 'not found' });

    // =====================================================================
    console.log('\n▶ GET /catalog');
    const catalog = await jsonRequest(port, '/catalog', { token });
    eq('catalog 200', catalog.status, 200);
    ok('catalog providers 是数组且 2 条', Array.isArray(catalog.json?.providers) && catalog.json.providers.length === 2);

    const deepseek = catalog.json.providers.find((provider) => provider.id === 'deepseek-official');
    const broken = catalog.json.providers.find((provider) => provider.id === 'broken-route');
    eq('provider label 用 DSH 的 name', deepseek?.label, 'DeepSeek');
    eq('正常 provider error=null', deepseek?.error, null);
    ok('模型目录 3 个', Array.isArray(deepseek?.models) && deepseek.models.length === 3);

    const flash = deepseek.models.find((model) => model.id === 'deepseek-flash');
    eq('reasoning levels 取 efforts.id', flash?.levels, ['low', 'high', 'max']);
    eq('defaultLevel 取官方默认 defaultEffort', flash?.defaultLevel, 'high');

    const pro = deepseek.models.find((model) => model.id === 'deepseek-v4-pro');
    eq('无 defaultEffort 时 defaultLevel 取第一个', pro?.defaultLevel, 'low');

    const plain = deepseek.models.find((model) => model.id === 'plain-model');
    eq('无 reasoning 时 levels=[]', plain?.levels, []);
    eq('无 reasoning 时 defaultLevel=""', plain?.defaultLevel, '');

    eq('失败 provider 的 models 为空', broken?.models, []);
    ok('失败 provider 只写自己的 error', typeof broken?.error === 'string' && broken.error.includes('mock listModels boom'), String(broken?.error));
    ok('失败 provider 不影响旁边的 provider', deepseek?.error === null);

    // 缓存：紧接着再读一次，listModels 不该被再调
    const callsAfterFirst = fake.calls.listModels;
    await jsonRequest(port, '/catalog', { token });
    eq('catalog 命中缓存（≤10s）', fake.calls.listModels, callsAfterFirst);
    await sleep(220);
    await jsonRequest(port, '/catalog', { token });
    eq('catalog 超过 TTL 后重建', fake.calls.listModels, callsAfterFirst + 2);

    // 模型级解析失败：保留模型、档位为空，不拖垮 provider
    fake.setExtraModels([{ id: 'weird-model', name: 'Weird' }]);
    await sleep(220);
    const catalogWeird = await jsonRequest(port, '/catalog', { token });
    const weirdProvider = catalogWeird.json.providers.find((provider) => provider.id === 'deepseek-official');
    const weird = weirdProvider.models.find((model) => model.id === 'weird-model');
    eq('模型级解析失败仍保留模型', weird?.levels, []);
    eq('模型级解析失败不影响 provider error', weirdProvider?.error, null);
    fake.setExtraModels([]);
    await sleep(220);

    // listProviders 整体失败 → 500
    fake.flags.failProviders = true;
    await sleep(220);
    const catalogError = await jsonRequest(port, '/catalog', { token });
    eq('listProviders 抛错 → 500', catalogError.status, 500);
    ok('500 带原因', typeof catalogError.json?.error === 'string' && catalogError.json.error.includes('mock listProviders boom'));
    fake.flags.failProviders = false;
    await sleep(220);

    // =====================================================================
    console.log('\n▶ POST /stream：事件顺序与协议翻译');
    fake.setStream(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Hel' };
      yield { type: 'text-delta', index: 0, text: 'lo' };
      yield { type: 'reasoning-delta', index: 0, text: 'SECRET-REASONING' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } };
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 1, id: 'c1', name: 'srv__tool', argumentsDelta: '{"a":' };
      yield { type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: '1}' };
      yield {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: 'c1', name: 'srv__tool', arguments: '{"a":1}' },
      };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, totalTokens: 17 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    });
    fake.calls.streams.length = 0;

    const streamed = await streamEvents(port, token, FULL_REQUEST);
    eq('stream 200', streamed.status, 200);
    ok('stream content-type 是 text/event-stream', String(streamed.headers.get('content-type')).includes('text/event-stream'));
    eq('SSE 事件顺序', streamed.events.map((event) => event.type), ['delta', 'delta', 'tool', 'usage', 'done']);
    eq('delta 文本「Hel」', streamed.events[0].text, 'Hel');
    eq('delta 文本「lo」', streamed.events[1].text, 'lo');
    eq('tool 事件由 delta 累积而来', streamed.events[2], {
      type: 'tool',
      id: 'c1',
      name: 'srv__tool',
      arguments: '{"a":1}',
    });
    eq('usage 映射（prompt 含 cache）', streamed.events[3], {
      type: 'usage',
      promptTokens: 12,
      completionTokens: 5,
    });
    eq('done 收尾', streamed.events[4], { type: 'done' });
    ok('reasoning-delta 不转发', !streamed.text.includes('SECRET-REASONING'));

    // 传给 ctx.llm 的请求必须已经翻成 DSH 的形状
    const llmOptions = fake.calls.streams[0];
    eq(
      'provider/model/reasoningEffort/system 透传',
      [llmOptions?.provider, llmOptions?.model, llmOptions?.reasoningEffort, llmOptions?.system],
      ['deepseek-official', 'deepseek-flash', 'max', '你是测试助手'],
    );
    ok('signal 是 AbortSignal', llmOptions?.signal instanceof AbortSignal);
    eq('messages 角色顺序', llmOptions?.messages.map((message) => message.role), ['user', 'assistant', 'tool']);
    eq('user 消息是 RequestUserInput 形状', llmOptions?.messages[0], {
      role: 'user',
      content: [{ type: 'text', text: '第一问' }],
    });
    eq('assistant tool-call 块被保留', llmOptions?.messages[1].content, [
      { type: 'tool-call', id: 'c1', name: 'srv__tool', arguments: '{"a":1}' },
    ]);
    eq('assistant 消息带 source', llmOptions?.messages[1].source, {
      kind: 'model',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    });
    eq('tool 消息带 toolCallId 与 source', {
      role: llmOptions?.messages[2].role,
      toolCallId: llmOptions?.messages[2].toolCallId,
      content: llmOptions?.messages[2].content,
      source: llmOptions?.messages[2].source,
    }, {
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'text', text: '工具结果' }],
      source: { kind: 'tool', callId: 'c1' },
    });
    eq('tools 原样透传', llmOptions?.tools, FULL_REQUEST.tools);

    // =====================================================================
    console.log('\n▶ POST /stream：异常/收尾语义');
    fake.setStream(async function* () {
      yield { type: 'text-delta', index: 0, text: 'trunc' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    });
    const truncated = await streamEvents(port, token, SIMPLE_REQUEST);
    eq('finish=max-tokens 也算 done', truncated.events.map((event) => event.type), ['delta', 'done']);

    fake.setStream(async function* () {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '调用被取消', code: 'ABORTED' } } };
    });
    const aborted = await streamEvents(port, token, SIMPLE_REQUEST);
    eq('finish=aborted → error 事件', aborted.events.map((event) => event.type), ['error']);
    eq('aborted 错误信息', [aborted.events[0].message, aborted.events[0].code], ['调用被取消', 'ABORTED']);

    fake.setStream(async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '上游 401', code: 'AUTH' } } };
    });
    const failed = await streamEvents(port, token, SIMPLE_REQUEST);
    eq('finish=error → error 事件', failed.events, [{ type: 'error', message: '上游 401', code: 'AUTH' }]);

    fake.setStream(async function* () {
      yield { type: 'text-delta', index: 0, text: 'x' };
      throw new Error('mock 中途爆炸');
    });
    const thrown = await streamEvents(port, token, SIMPLE_REQUEST);
    eq('流中途抛错 → delta 后跟 error', thrown.events.map((event) => event.type), ['delta', 'error']);
    ok('流中途抛错带原因', String(thrown.events[1]?.message).includes('mock 中途爆炸'));

    fake.setStream(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const recovered = await streamEvents(port, token, SIMPLE_REQUEST);
    eq('异常之后 bridge 仍可继续服务', recovered.events.map((event) => event.type), ['done']);

    // =====================================================================
    console.log('\n▶ POST /stream：请求校验');
    const badToken = await jsonRequest(port, '/stream', { method: 'POST', token: token + 'x', body: SIMPLE_REQUEST });
    eq('stream 错 token → 401', badToken.status, 401);

    const badJson = await jsonRequest(port, '/stream', { method: 'POST', token, body: '{oops' });
    eq('坏 JSON → 400', badJson.status, 400);
    eq('坏 JSON body', badJson.json, { error: 'bad json' });

    const missingProvider = await jsonRequest(port, '/stream', {
      method: 'POST',
      token,
      body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
    });
    eq('缺 provider → 400', missingProvider.status, 400);
    ok('缺 provider 带原因', String(missingProvider.json?.error).includes('provider'));

    const badMessage = await jsonRequest(port, '/stream', {
      method: 'POST',
      token,
      body: { provider: 'deepseek-official', model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }, { role: 'nope', content: 'x' }] },
    });
    eq('不支持的消息 role → 400', badMessage.status, 400);

    const bigBody = await rawRequest(port, '/stream', {
      method: 'POST',
      token,
      body: JSON.stringify({
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 10) }],
      }),
    });
    eq('body >1MB → 413', bigBody.status, 413);
    eq('413 body', bigBody.json, { error: 'body too large' });

    // =====================================================================
    console.log('\n▶ 并发上限 8');
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    let started = 0;
    fake.setStream(async function* () {
      started += 1;
      await gate;
      yield { type: 'finish', reason: { kind: 'stop' } };
    });

    const concurrent = [];
    for (let i = 0; i < 8; i += 1) concurrent.push(openStream(port, token, SIMPLE_REQUEST));
    ok('8 个流都进入 ctx.llm.stream', await waitUntil(() => started === 8));

    const ninth = await jsonRequest(port, '/stream', { method: 'POST', token, body: SIMPLE_REQUEST });
    eq('第 9 个并发 → 429', ninth.status, 429);
    eq('429 body', ninth.json, { error: 'bridge busy' });

    releaseGate();
    const concurrentBodies = await Promise.all((await Promise.all(concurrent)).map((res) => res.text()));
    ok('放行后 8 个并发流都收到 done', concurrentBodies.every((text) => text.includes('"type":"done"')));

    fake.setStream(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const afterBusy = await streamEvents(port, token, SIMPLE_REQUEST);
    eq('并发释放后可继续调用', afterBusy.events.map((event) => event.type), ['done']);

    // =====================================================================
    console.log('\n▶ 客户端断开 → abort 底层 ctx.llm.stream');
    let underlyingSignal = null;
    fake.setStream(async function* (options) {
      underlyingSignal = options.signal;
      try {
        for (let i = 0; i < 200; i += 1) {
          if (options.signal.aborted) throw new Error('aborted');
          yield { type: 'text-delta', index: 0, text: 'tick' };
          await sleep(30);
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      } catch (err) {
        throw err;
      }
    });

    const abortController = new AbortController();
    const abortRes = await openStream(port, token, SIMPLE_REQUEST, abortController.signal);
    const reader = abortRes.body.getReader();
    await reader.read();
    abortController.abort();
    ok('断开后底层 signal 被 abort', await waitUntil(() => Boolean(underlyingSignal && underlyingSignal.aborted)));
    await reader.cancel().catch(() => {});

    // =====================================================================
    console.log('\n▶ 单请求超时');
    const dirB = path.join(root, 'b');
    const fakeB = createFakeLlm();
    fakeB.setStream(async function* (options) {
      while (!options.signal.aborted) {
        await sleep(20);
      }
      // 故意不发 finish，模拟卡死
    });
    const stopB = startBridge({ llm: fakeB.llm }, { dir: dirB, port: 0, requestTimeoutMs: 200 });
    stops.push(stopB);
    const infoB = await waitForInfo(dirB);
    const timedOut = await streamEvents(infoB.info.port, infoB.info.token, SIMPLE_REQUEST);
    eq('超时 → error 事件', timedOut.events.map((event) => event.type), ['error']);
    eq('超时错误码', timedOut.events[0].code, 'BRIDGE_TIMEOUT');
    ok('超时文案可读', String(timedOut.events[0].message).includes('超时'));

    // =====================================================================
    console.log('\n▶ 端口被占用 → listen(0)');
    const occupiedPort = await getFreePort();
    const dirC1 = path.join(root, 'c1');
    const dirC2 = path.join(root, 'c2');
    const fakeC = createFakeLlm();
    const stopC1 = startBridge({ llm: fakeC.llm }, { dir: dirC1, port: occupiedPort });
    stops.push(stopC1);
    const infoC1 = await waitForInfo(dirC1);
    const stopC2 = startBridge({ llm: fakeC.llm }, { dir: dirC2, port: occupiedPort });
    stops.push(stopC2);
    const infoC2 = await waitForInfo(dirC2);
    eq('第一个占住首选端口', infoC1.info.port, occupiedPort);
    ok('第二个回落到随机端口', infoC2.info.port !== occupiedPort && infoC2.info.port > 0, `port=${infoC2.info.port}`);
    const healthC2 = await jsonRequest(infoC2.info.port, '/health', { token: infoC2.info.token });
    eq('回落后服务可用', healthC2.status, 200);

    // =====================================================================
    console.log('\n▶ dispose：关服务 + 删发现文件');
    await stopA();
    const afterStop = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } }).then(
      () => true,
      () => false,
    );
    eq('关掉后不再响应', afterStop, false);
    const fileGone = await fs.access(file).then(() => false, () => true);
    eq('dispose 删除发现文件', fileGone, true);

    // =====================================================================
    console.log('\n▶ index.js 接线（假 ctx + 真 apply）');
    dummyBackend = http.createServer((_req, res) => res.end('ok'));
    await new Promise((resolve, reject) => {
      dummyBackend.once('error', reject);
      dummyBackend.listen(0, '127.0.0.1', resolve);
    });
    const dummyPort = dummyBackend.address().port;

    const indexModule = await import('../index.js');
    ok('inject 含 llm', Array.isArray(indexModule.inject) && indexModule.inject.includes('llm'));

    const dirD = path.join(root, 'd');
    const fakeD = createFakeLlm();
    const effects = [];
    const pluginCtx = {
      llm: fakeD.llm,
      tools: { register() {} },
      effect(execute, label) {
        const disposer = execute();
        effects.push({ label, disposer });
        return async () => {
          if (typeof disposer === 'function') await disposer();
        };
      },
    };
    indexModule.apply(pluginCtx, { agentflowDir: dirD, agentflowPort: dummyPort });
    const infoD = await waitForInfo(dirD);
    const healthD = await jsonRequest(infoD.info.port, '/health', { token: infoD.info.token });
    eq('apply 启动 bridge 后 /health 200', healthD.status, 200);

    for (const effect of effects.reverse()) {
      if (typeof effect.disposer === 'function') await effect.disposer();
    }
    const fileGoneD = await fs.access(infoD.file).then(() => false, () => true);
    eq('effect dispose 后删除发现文件', fileGoneD, true);
  } finally {
    for (const stop of stops.reverse()) {
      try {
        await stop();
      } catch {}
    }
    if (dummyBackend) await new Promise((resolve) => dummyBackend.close(resolve));
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
