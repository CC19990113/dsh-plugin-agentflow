// verify.mjs —— 节点的「结果判断」。
//
// 三种模式（用户在卡片详情里选）：
//   human ：跑完停住，标成 review，等人点通过/打回
//   jev   ：调 TypeSafe System One 判定（只给概率，不出文）
//   self  ：同一个模型自评是否达到 criteria
//
// TypeSafe 在中国区返回 451（2026-10-19 实测），所以这里支持走 HTTP 代理。
// Node 自带 fetch 不认代理，为了保持零依赖，这里用裸 http/https 手写 CONNECT 隧道。

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';

/**
 * 通过 HTTP 代理发一个 HTTPS POST。
 * 不依赖 undici / https-proxy-agent：CONNECT 拿到裸 socket，再在它上面做 TLS。
 */
function postJsonViaProxy({ proxyUrl, url, headers, body, timeoutMs = 20000 }) {
  const proxy = new URL(proxyUrl);
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    const timer = setTimeout(() => done(reject, new Error(`代理请求超时 ${timeoutMs}ms`)), timeoutMs);

    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: { Host: `${target.hostname}:443` },
    });

    connectReq.on('error', (err) => {
      clearTimeout(timer);
      done(reject, new Error(`代理连接失败：${err.message}`));
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        socket.destroy();
        return done(reject, new Error(`代理拒绝 CONNECT：HTTP ${res.statusCode}`));
      }

      // 关键：必须用一个自定义 Agent 来接管 socket。
      // 之前用 `agent: false` + createConnection 是不行的 —— agent:false 会新建一个
      // 默认 Agent，createConnection 永远不被调用，结果还是直连，照样 451。
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = (opts, cb) => {
        const tlsSocket = tls.connect(
          { socket, servername: target.hostname },
          () => cb(null, tlsSocket)
        );
        tlsSocket.once('error', (err) => cb(err));
      };

      const req = https.request(
        {
          host: target.hostname,
          path: target.pathname + target.search,
          method: 'POST',
          headers,
          agent,
        },
        (pres) => {
          let text = '';
          pres.setEncoding('utf8');
          pres.on('data', (d) => (text += d));
          pres.on('end', () => {
            clearTimeout(timer);
            agent.destroy();
            done(resolve, { status: pres.statusCode, body: text });
          });
        }
      );
      req.on('error', (err) => {
        clearTimeout(timer);
        agent.destroy();
        done(reject, err);
      });
      req.end(body);
    });

    connectReq.end();
  });
}

/** 直连（没有配代理时用） */
async function postJsonDirect({ url, headers, body, timeoutMs = 20000 }) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.text() };
}

/**
 * 问一次 Jev：这段内容是否达标。
 * @returns { pass: boolean, score: number, raw: object }
 */
export async function askJev({ apiKey, proxy, content, criteria, timeoutMs }) {
  if (!apiKey) throw new Error('没有配 jev 的 apiKey');

  const instructions = criteria
    ? `判断下面这段内容是否达到以下标准：${criteria}`
    : '判断下面这段内容是否完整、可用地完成了一个明确任务';

  const payload = {
    state: { content: String(content).slice(0, 12000) },
    model: JEV_MODEL,
    questions: {
      ok: {
        type: 'noul',
        instructions,
      },
    },
  };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
  };
  const body = JSON.stringify(payload);

  const run = (opts) =>
    proxy
      ? postJsonViaProxy({ ...opts, proxyUrl: proxy, url: JEV_ENDPOINT, headers, body })
      : postJsonDirect({ ...opts, url: JEV_ENDPOINT, headers, body });

  let res;
  try {
    res = await run({ timeoutMs });
  } catch (err) {
    throw new Error(`Jev 调用失败：${err.message}`);
  }

  if (res.status === 451) {
    throw new Error('TypeSafe 返回 451（地区封锁），需要在配置里填 HTTP 代理');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Jev HTTP ${res.status}：${String(res.body).slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error(`Jev 返回不是 JSON：${String(res.body).slice(0, 200)}`);
  }

  // 实测线上形如 { "type": "noul", "noul": 0.95 }；也兼容 answers.ok.noul 包一层
  const score =
    Number(data?.noul) ||
    Number(data?.answers?.ok?.noul) ||
    Number(data?.questions?.ok?.noul) ||
    0;

  return { pass: score >= 0.5, score, raw: data };
}

/**
 * 模型自评：让同一个模型对照 criteria 检查自己刚写的内容。
 * 复用传入的 callLLM（所以自动带上同一节点的 provider / mock 设置）。
 */
export async function selfVerify(callLLM, node, content) {
  const judgeNode = { ...node, skills: [], tools: [], verify: '' };
  const prompt = [
    '这是一个【质量检查】任务。你只能判定，绝对不能重写、续写或补充内容。',
    '',
    '【当初的任务要求】',
    node.task || '(无)',
    '',
    '【完成标准】',
    node.criteria || '内容完整、可用地完成了任务',
    '',
    '【需要判定的内容】',
    '<<<',
    String(content).slice(0, 12000),
    '>>>',
    '',
    '只输出一行，不要任何其他文字、不要解释、不要重复内容：',
    'PASS|不超过30字的理由',
    '或',
    'FAIL|不超过30字的理由',
  ].join('\n');

  const res = await callLLM(judgeNode, prompt);
  const text = String(res.content || '').trim();

  // 宽松取结果：优先看行首，其次找第一个独立出现的关键词
  let verdictWord = '';
  const head = /^(PASS|FAIL)/i.exec(text);
  if (head) verdictWord = head[1].toUpperCase();
  else {
    const anywhere = /\b(PASS|FAIL)\b/i.exec(text.slice(0, 80));
    if (anywhere) verdictWord = anywhere[1].toUpperCase();
  }

  const pass = verdictWord === 'PASS';
  let reason = text.replace(/^(PASS|FAIL)\s*[|｜:：]?\s*/i, '').replace(/\s+/g, ' ').trim();
  if (!verdictWord) {
    reason = `模型没按格式回答（${text.slice(0, 40)}…），按未通过处理`;
  }
  return { pass, reason: reason.slice(0, 60), raw: text };
}
