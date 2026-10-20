// dsh-source.mjs —— AgentFlow 的「DSH 版」配置来源。
//
// 原则：模型、MCP、技能**一律取自 DSH 自己的配置**，AgentFlow 不再自带一套。
//   - 模型：DSH 内核的 llm bridge（GET /catalog），不读凭据、不直连 /models
//   - MCP ：cordis.patch.yml 里所有 dsh-mcp-client 行
//   - 技能：~/.dsh/skills
//
// 这样做的代价是：DSH 里没配的东西，AgentFlow 里也用不了。这是有意的。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { bridgeCatalog } from './bridge.mjs';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', 'desktop');
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml');
const SKILL_DIR = path.join(DSH_HOME, 'skills');
/** bridge 发现文件所在目录：<dir>/data/dsh-bridge.json */
const DEFAULT_BRIDGE_DIR = path.join(DSH_HOME, 'agent-flow');

// ---------------------------------------------------------------------------
// 极简 YAML：够读 cordis.patch.yml 的「数组项 → 缩进映射/列表」这一种形状。
// 不追求通用，只求把 loader patch 的结构读出来。注释、`!!js` 标签都跳过。
// ---------------------------------------------------------------------------

function parseScalar(raw) {
  let v = raw.trim();
  if (v === '') return '';
  // 去掉行尾注释（引号外的 #）
  let inQuote = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (c === '#' && (i === 0 || v[i - 1] === ' ')) {
      v = v.slice(0, i).trim();
      break;
    }
  }
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** 把 YAML 文本拆成 {indent, content, raw} 行数组，丢掉空行与整行注释 */
function meaningfulLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - trimmed.length;
    out.push({ indent, content: trimmed.replace(/\s+$/, ''), raw });
  }
  return out;
}

/**
 * 解析一小段 YAML（从 start 行开始的连续块），返回 {value, next}。
 * 只处理三种形状：映射 `k: v`、数组 `- v`、数组里的映射 `- k: v`。
 */
function parseBlock(lines, start, indent) {
  if (start >= lines.length) return { value: null, next: start };
  const isArray = lines[start].indent === indent && lines[start].content.startsWith('-');
  const container = isArray ? [] : {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) { i++; continue; } // 不该出现，跳过
    if (isArray && !line.content.startsWith('-')) break;
    if (!isArray && line.content.startsWith('-')) break;

    if (isArray) {
      const body = line.content.slice(1).trim();
      if (body === '') {
        // 「- 」后面换行接子块
        const sub = parseBlock(lines, i + 1, lines[i + 1]?.indent ?? indent + 2);
        container.push(sub.value);
        i = sub.next;
        continue;
      }
      const kv = /^([\w$.\-@/]+)\s*:\s*(.*)$/.exec(body);
      if (kv) {
        // 「- key: value」开始一个映射，后续同缩进的键并入
        const itemIndent = line.indent + 2;
        const item = {};
        const headKey = kv[1];
        const headVal = kv[2];
        if (headVal !== '') {
          item[headKey] = parseScalar(headVal);
          i++;
        } else {
          const sub = parseBlock(lines, i + 1, lines[i + 1]?.indent ?? itemIndent + 2);
          item[headKey] = sub.value;
          i = sub.next;
        }
        // 继续吃同一项的其它键
        while (i < lines.length && lines[i].indent === itemIndent && !lines[i].content.startsWith('-')) {
          const k2 = /^([\w$.\-@/]+)\s*:\s*(.*)$/.exec(lines[i].content);
          if (!k2) { i++; continue; }
          if (k2[2] !== '') {
            item[k2[1]] = parseScalar(k2[2]);
            i++;
          } else {
            const sub2 = parseBlock(lines, i + 1, lines[i + 1]?.indent ?? itemIndent + 2);
            item[k2[1]] = sub2.value;
            i = sub2.next;
          }
        }
        container.push(item);
        continue;
      }
      container.push(parseScalar(body));
      i++;
      continue;
    }

    const kv = /^([\w$.\-@/]+)\s*:\s*(.*)$/.exec(line.content);
    if (!kv) { i++; continue; }
    if (kv[2] !== '') {
      container[kv[1]] = parseScalar(kv[2]);
      i++;
    } else {
      const sub = parseBlock(lines, i + 1, lines[i + 1]?.indent ?? indent + 2);
      container[kv[1]] = sub.value;
      i = sub.next;
    }
  }
  return { value: container, next: i };
}

/** 读 patch 文件 → 顶层数组 */
async function readPatch() {
  const text = await fs.readFile(PATCH_FILE, 'utf8').catch(() => '');
  if (!text.trim()) return [];
  const lines = meaningfulLines(text);
  if (!lines.length) return [];
  const { value } = parseBlock(lines, 0, lines[0].indent);
  return Array.isArray(value) ? value : [];
}

/** 把 patch 里的每一行摊平（insert 进来的行也摊平） */
function flattenRows(patch) {
  const rows = [];
  for (const entry of patch) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.insert)) {
      for (const row of entry.insert) if (row && typeof row === 'object') rows.push(row);
    } else if (entry.id || entry.name) {
      rows.push(entry);
    }
  }
  return rows;
}

/**
 * 读 DSH 配的 MCP 服务器。
 * @returns {Promise<Record<string, object>>} serverName → spec
 */
export async function readDshMcpServers() {
  const rows = flattenRows(await readPatch());
  const servers = {};
  for (const row of rows) {
    const pkg = String(row.name || '');
    if (!pkg.includes('dsh-mcp-client')) continue;
    const cfg = row.config || {};
    const name = cfg.serverName;
    if (!name) continue;
    // 转成 AgentFlow mcp.mjs 认的 spec 形状
    if (cfg.transport === 'stdio') {
      servers[name] = {
        command: cfg.command,
        args: cfg.args || [],
        env: cfg.env || {},
        cwd: cfg.cwd,
        source: 'dsh',
      };
    } else {
      servers[name] = {
        url: cfg.url,
        headers: cfg.headers || {},
        source: 'dsh',
      };
    }
  }
  return servers;
}

/** DSH 的技能目录 */
export function readDshSkillDirs() {
  return [SKILL_DIR];
}

// ---------------------------------------------------------------------------
// 模型目录：只从 bridge 的 GET /catalog 取。
//
// 不再读 .credentials.yaml、不再直连各家的 /models、也不再判断「是不是 OpenAI 兼容」——
// DSH 里能用什么模型，由内核说了算；bridge 侧缓存 ≤10 秒，这里不再加自己的长缓存。
// ---------------------------------------------------------------------------

/** 最近一次成功读到目录的时间；/api/bridge 用它算 catalogAgeMs */
let lastCatalogOkAt = 0;

/** 最近一次成功拿到目录距今多久（ms）；从未成功返回 null */
export function dshCatalogAgeMs() {
  return lastCatalogOkAt ? Date.now() - lastCatalogOkAt : null;
}

/** 把 bridge 的 model 条目归一成 AgentFlow 前端认的形状；字段缺了就留空，不编默认值 */
function normalizeCatalogModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;
  const levels = Array.isArray(raw.levels) ? raw.levels.filter((x) => typeof x === 'string' && x) : [];
  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    levels,
    defaultLevel: typeof raw.defaultLevel === 'string' ? raw.defaultLevel : levels[0] || '',
  };
}

/** 把 bridge 的 providers 归一：单条缺 id 的丢掉，models 过滤坏项 */
export function normalizeCatalogProviders(rawProviders) {
  if (!Array.isArray(rawProviders)) return [];
  const out = [];
  for (const p of rawProviders) {
    if (!p || typeof p !== 'object') continue;
    const id = typeof p.id === 'string' ? p.id : '';
    if (!id) continue;
    const models = Array.isArray(p.models)
      ? p.models.map(normalizeCatalogModel).filter(Boolean)
      : [];
    out.push({
      id,
      label: typeof p.label === 'string' && p.label ? p.label : id,
      models,
      error: p.error == null ? null : String(p.error),
    });
  }
  return out;
}

/**
 * 读 DSH 实际可用的模型目录（只走 bridge）。
 * bridge 不可用时返回空 providers + error，不抛错 —— 页面照常能开，只是选不到模型。
 * @param {string} [dir] bridge 发现文件所在目录
 * @returns {Promise<{providers: Array, fetchedAt: number, cached: boolean, error?: string}>}
 */
export async function readDshModelCatalog(dir = DEFAULT_BRIDGE_DIR) {
  let body;
  try {
    body = await bridgeCatalog(dir);
  } catch (err) {
    return {
      providers: [],
      fetchedAt: Date.now(),
      cached: false,
      error: String((err && err.message) || err),
    };
  }
  lastCatalogOkAt = Date.now();
  return {
    providers: normalizeCatalogProviders(body.providers),
    fetchedAt: lastCatalogOkAt,
    cached: false,
  };
}

/** 一次性读除模型外的 DSH 配置（模型目录由 readDshModelCatalog 单独取，走 bridge） */
export async function readDshSource() {
  const mcpServers = await readDshMcpServers();
  return {
    mcpServers,
    skillDirs: readDshSkillDirs(),
    paths: { patch: PATCH_FILE, skills: SKILL_DIR },
  };
}
