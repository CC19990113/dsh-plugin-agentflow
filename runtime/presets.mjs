// presets.mjs —— DSH agent preset 的读取与增删（供设置页「AgentFlow」分区用）。
//
// 自定义预设散在两处：
//   1. profile 的 cordis.patch.yml（AgentFlow 导出的标记段 + 用户手写的覆写行）
//   2. 各 bundle 包自己的 cordis.patch.yml（sharp-agent、qq-vibe 这类插件带的预设）
// 这里用文本解析（不引 YAML 库），够读 `@deepseek-ai/dsh-agent-preset` 这一种形状。
// 写入只动 profile：bundle 里的预设属于插件包，改了会被升级覆盖，所以只允许复制。

import fs from 'node:fs/promises';
import path from 'node:path';

const PRESET_COMPONENT = '@deepseek-ai/dsh-agent-preset';

/** 手动复制/编辑产生的自定义预设写在这一段里，与 AgentFlow 导出的段分开 */
const MANUAL_BLOCK_START = '# >>> AgentFlow 自定义预设（手动复制/编辑，重新导出不会覆盖）';
const MANUAL_BLOCK_END = '# <<< AgentFlow 自定义预设结束';

function unquote(raw) {
  const v = String(raw ?? '').trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

function yamlString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * 从一份 patch 文本里抽出所有 agent preset 定义。
 * @param {string} text patch 文本
 * @param {{source:'profile'|'bundle', packageName?:string}} meta
 * @returns {Array<{rowId:string,id:string,name:string,description:string,source:string,packageName:string|null,order:number,lineStart:number,lineEnd:number}>}
 */
export function extractPresets(text, meta = { source: 'profile', packageName: null }) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // 精确匹配组件名，别把 dsh-agent-preset-registry 也当成预设
    if (!/^\s*name:\s*['"]?@deepseek-ai\/dsh-agent-preset['"]?\s*$/.test(lines[i])) continue;
    // 向上找这一行的 id（- id: preset-xxx）
    let rowId = '';
    let rowIndent = 0;
    let rowStart = -1;
    for (let j = i; j >= 0; j--) {
      const m = /^\s*-\s+id:\s*(\S+)\s*$/.exec(lines[j]);
      if (m) {
        rowId = unquote(m[1]);
        rowIndent = indentOf(lines[j]);
        rowStart = j;
        break;
      }
      if (lines[j].trim() && indentOf(lines[j]) < indentOf(lines[i]) && !lines[j].trim().startsWith('-')) break;
    }
    if (!rowId) continue;

    // 这一行的结束：下一个缩进 <= rowIndent 且是数组项的行
    let rowEnd = lines.length;
    for (let j = rowStart + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t || t.startsWith('#')) continue;
      if (indentOf(lines[j]) <= rowIndent && /^-\s/.test(t)) {
        rowEnd = j;
        break;
      }
    }

    // 解析 config 下的 id / name / description / order
    let cfgIndent = -1;
    let id = '';
    let name = '';
    let description = '';
    let order = 0;
    for (let j = i + 1; j < rowEnd; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = indentOf(line);
      if (cfgIndent < 0) {
        if (/^\s*config:\s*$/.test(line)) cfgIndent = indent;
        continue;
      }
      if (indent <= cfgIndent) break;
      let m;
      if (!id && (m = /^\s*id:\s*(\S+)\s*$/.exec(line))) id = unquote(m[1]);
      else if (!name && (m = /^\s*name:\s*(.+)$/.exec(line))) name = unquote(m[1]);
      else if (!description && (m = /^\s*description:\s*(.+)$/.exec(line))) description = unquote(m[1]);
      else if (!order && (m = /^\s*order:\s*(\d+)\s*$/.exec(line))) order = Number(m[1]);
    }

    out.push({
      rowId,
      id: id || rowId.replace(/^preset-/, ''),
      name: name || id || rowId,
      description,
      source: meta.source,
      packageName: meta.packageName ?? null,
      order,
      lineStart: rowStart,
      lineEnd: rowEnd,
    });
  }
  return out;
}

/** 读一个文件，不存在返回空串 */
async function readOr(file, fallback = '') {
  return fs.readFile(file, 'utf8').catch(() => fallback);
}

/**
 * 列出所有自定义预设（profile + 各 bundle），同 id 时 profile 覆盖 bundle。
 * @param {string} profileDir
 */
export async function listPresets(profileDir) {
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const pkgFile = path.join(profileDir, 'package.json');

  const patch = await readOr(patchFile);
  const fromProfile = extractPresets(patch, { source: 'profile', packageName: null });

  let bundles = [];
  try {
    const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8'));
    bundles = pkg?.dsh?.profile?.bundles || [];
  } catch {
    bundles = [];
  }

  const fromBundles = [];
  for (const bundle of bundles) {
    const file = path.join(profileDir, 'node_modules', bundle, 'cordis.patch.yml');
    const text = await readOr(file, '');
    if (!text) continue;
    fromBundles.push(...extractPresets(text, { source: 'bundle', packageName: bundle }));
  }

  const byId = new Map();
  for (const item of fromBundles) byId.set(item.id, item);
  for (const item of fromProfile) byId.set(item.id, item);

  return [...byId.values()]
    .map(({ lineStart, lineEnd, ...rest }) => ({
      ...rest,
      editable: rest.source === 'profile',
      canCopy: true,
    }))
    .sort((a, b) => (a.order || 99) - (b.order || 99) || a.name.localeCompare(b.name));
}

/** 读 profile patch 与它里面某个 preset 的原始文本块（含 plugins） */
async function readProfilePresetBlock(profileDir, presetId) {
  const file = path.join(profileDir, 'cordis.patch.yml');
  const text = await fs.readFile(file, 'utf8');
  const found = extractPresets(text, { source: 'profile', packageName: null }).find((p) => p.id === presetId);
  if (!found) return null;
  const lines = text.split('\n');
  const block = lines.slice(found.lineStart, found.lineEnd).join('\n');
  return { file, text, found, block, lines };
}

/** 从原块里取 plugins 内容，并按相对缩进重排到 8 空格（config.plugins 下面） */
function extractPluginsBody(block) {
  const lines = String(block || '').split('\n');
  const idx = lines.findIndex((l) => /^\s*plugins:\s*$/.test(l));
  if (idx < 0) return '';
  // 注释行（块尾标记等）不能进 plugins 内容：它们的缩进是 0，
  // 归一化时会被切掉开头几个字符，把 `# <<< ...结束` 变成半截残片。
  const body = lines.slice(idx + 1).filter((l) => !l.trim().startsWith('#'));
  const nonEmpty = body.filter((l) => l.trim());
  if (!nonEmpty.length) return '';
  // 以子项（- id: xxx）的缩进为准：长文本块里的行缩进深浅不一，拿全量最小值会算错
  const itemLines = nonEmpty.filter((l) => /^\s*-\s+id:/.test(l));
  const minIndent = Math.min(...(itemLines.length ? itemLines : nonEmpty).map(indentOf));
  return body
    .map((l) => (l.trim() ? ' '.repeat(8) + l.slice(minIndent) : ''))
    .join('\n')
    .trimEnd();
}

/**
 * 生成一个完整的新预设块。
 * 必须用 `- insert:` 包裹：顶层 `- id: xxx` 的语义是「覆写已有行」，
 * 新 id 不存在时整行会被 loader 忽略（踩过）。
 */
function buildPresetBlock({ presetId, name, description, order, plugins }) {
  const lines = [
    '- insert:',
    `  - id: preset-${presetId}`,
    "    name: '@deepseek-ai/dsh-agent-preset'",
    '    config:',
    `      id: ${presetId}`,
    `      name: ${yamlString(name)}`,
    `      description: ${yamlString(description || '')}`,
    `      order: ${order || 50}`,
  ];
  if (plugins) lines.push('      plugins:', plugins);
  return lines.join('\n');
}

/** 生成一个不冲突的预设 id */
async function uniqueId(profileDir, base) {
  const existing = new Set((await listPresets(profileDir)).map((p) => p.id));
  let candidate = `${base}-copy`;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-copy${n}`;
    n++;
  }
  return candidate;
}

/** 把一段文本写进 profile 的自定义预设标记段（已有则替换同一 id 的块） */
async function upsertManualBlock(profileDir, newId, block) {
  const file = path.join(profileDir, 'cordis.patch.yml');
  const text = await fs.readFile(file, 'utf8');
  const manualStart = text.indexOf(MANUAL_BLOCK_START);
  const head = manualStart >= 0 ? text.slice(0, manualStart).trimEnd() : text.trimEnd();
  const manual = manualStart >= 0
    ? text.slice(manualStart)
        .replace(MANUAL_BLOCK_START, '')
        .replace(MANUAL_BLOCK_END, '')
    : '';

  // 去掉旧的自定义段，重新拼：原有条目 + 这次的新块
  const kept = manual
    .split(/\n(?=\s*-\s+id:\s+)/)
    .filter((chunk) => chunk.trim() && !chunk.includes(`id: preset-${newId}`))
    .join('\n')
    .trim();

  const body = [kept, block.trim()].filter(Boolean).join('\n\n');
  const next = `${head}\n\n${MANUAL_BLOCK_START}\n${body}\n${MANUAL_BLOCK_END}\n`;
  await fs.writeFile(file, next, 'utf8');
  return file;
}

/**
 * 复制一个预设成新的自定义预设（写进 profile 的自定义段）。
 * bundle 来源也能复制 —— 这正是「把插件自带的预设改成自己的」的路径。
 */
export async function copyPreset(profileDir, presetId, opts = {}) {
  const newName = typeof opts.name === 'string' && opts.name.trim()
    ? opts.name.trim()
    : `${presetId} 副本`;
  const newId = await uniqueId(profileDir, presetId);

  // 先看 profile 自己的；没有再翻 bundle
  let block = null;
  const fromProfile = await readProfilePresetBlock(profileDir, presetId);
  if (fromProfile) {
    block = fromProfile.block;
  } else {
    const pkg = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'));
    for (const bundle of pkg?.dsh?.profile?.bundles || []) {
      const file = path.join(profileDir, 'node_modules', bundle, 'cordis.patch.yml');
      const text = await readOr(file, '');
      if (!text) continue;
      const found = extractPresets(text, { source: 'bundle', packageName: bundle }).find((p) => p.id === presetId);
      if (!found) continue;
      block = text.split('\n').slice(found.lineStart, found.lineEnd).join('\n');
      break;
    }
  }
  if (!block) throw new Error(`找不到预设：${presetId}`);

  // 原块的显示信息一起带过来，只换 id 与名字
  const meta = extractPresets(block, { source: 'profile', packageName: null })[0] || {};
  const cloned = buildPresetBlock({
    presetId: newId,
    name: newName,
    description: meta.description || '',
    order: meta.order || 50,
    plugins: extractPluginsBody(block),
  });
  const file = await upsertManualBlock(profileDir, newId, cloned);
  return { ok: true, id: newId, name: newName, file };
}

/**
 * 清理自定义预设段里删剩下的空壳：
 *   - 孤立的 `- insert:`（后面没有子项了）
 *   - 整段都空了就把标记段一起删掉
 */
function cleanupManualBlock(text) {
  const start = text.indexOf(MANUAL_BLOCK_START);
  if (start < 0) return text;
  const endIdx = text.indexOf(MANUAL_BLOCK_END);
  const bodyRaw = endIdx > start
    ? text.slice(start + MANUAL_BLOCK_START.length, endIdx)
    : text.slice(start + MANUAL_BLOCK_START.length);

  const lines = bodyRaw.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^-\s+insert:\s*$/.test(line)) {
      // 看后面还有没有属于它的子项（缩进更深的 - id:）
      let hasChild = false;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t || t.startsWith('#')) continue;
        hasChild = /^\s+-\s+/.test(lines[j]);
        break;
      }
      if (!hasChild) continue; // 空壳，丢掉
    }
    kept.push(line);
  }
  const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const head = text.slice(0, start).trimEnd();
  const tail = endIdx >= 0 ? text.slice(endIdx + MANUAL_BLOCK_END.length).replace(/^\n+/, '') : '';
  if (!body) {
    return `${head}\n${tail}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  return `${head}\n\n${MANUAL_BLOCK_START}\n${body}\n${MANUAL_BLOCK_END}\n${tail}`;
}

/** 从 preset 块里抽 persona 文本（plugins 里 id=persona 的 config.prefix 块标量） */
function extractPersona(block) {
  const lines = String(block || '').split('\n');
  const idx = lines.findIndex((l) => /^\s*prefix:\s*[|>]/.test(l));
  if (idx < 0) return '';
  const baseIndent = indentOf(lines[idx]);
  const raw = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && indentOf(line) <= baseIndent) break;
    raw.push(line);
  }
  const nonEmpty = raw.filter((l) => l.trim());
  if (!nonEmpty.length) return '';
  const minIndent = Math.min(...nonEmpty.map(indentOf));
  const text = raw.map((l) => (l.trim() ? l.slice(minIndent) : '')).join('\n');
  return text.replace(/\s+$/, '');
}

/**
 * 读一个预设的完整规格（名称/描述/persona 文本）。profile 优先，其次 bundle。
 * @returns {Promise<{id:string,name:string,description:string,persona:string,source:string,packageName:string|null}>}
 */
export async function exportPresetSpec(profileDir, presetId) {
  const wanted = String(presetId || '').trim();
  if (!wanted) throw new Error('exportPresetSpec 需要 presetId');

  const fromProfile = await readProfilePresetBlock(profileDir, wanted);
  if (fromProfile) {
    return {
      id: wanted,
      name: fromProfile.found.name || wanted,
      description: fromProfile.found.description || '',
      persona: extractPersona(fromProfile.block),
      source: 'profile',
      packageName: null,
    };
  }

  const pkg = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'));
  for (const bundle of pkg?.dsh?.profile?.bundles || []) {
    const file = path.join(profileDir, 'node_modules', bundle, 'cordis.patch.yml');
    const text = await readOr(file, '');
    if (!text) continue;
    const found = extractPresets(text, { source: 'bundle', packageName: bundle }).find((p) => p.id === wanted);
    if (!found) continue;
    const block = text.split('\n').slice(found.lineStart, found.lineEnd).join('\n');
    return {
      id: wanted,
      name: found.name || wanted,
      description: found.description || '',
      persona: extractPersona(block),
      source: 'bundle',
      packageName: bundle,
    };
  }
  throw Object.assign(new Error(`找不到预设：${wanted}`), { status: 404 });
}

/** 删除 profile 里的一个自定义预设（bundle 来源不允许删） */
export async function deletePreset(profileDir, presetId) {
  const file = path.join(profileDir, 'cordis.patch.yml');
  const text = await fs.readFile(file, 'utf8');
  const found = extractPresets(text, { source: 'profile', packageName: null }).find((p) => p.id === presetId);
  if (!found) {
    throw Object.assign(new Error(`profile 里没有这个预设：${presetId}（bundle 自带的只能复制，不能删）`), { status: 400 });
  }
  const lines = text.split('\n');
  const before = lines.slice(0, found.lineStart);
  const after = lines.slice(found.lineEnd);
  // 顺手吃掉块尾多出来的空行，避免越删越多空行
  while (after.length && after[0].trim() === '') after.shift();
  let next = `${before.join('\n').trimEnd()}\n${after.join('\n')}`.replace(/\n{3,}/g, '\n\n');
  next = cleanupManualBlock(next);
  await fs.writeFile(file, next.endsWith('\n') ? next : next + '\n', 'utf8');
  return { ok: true, id: presetId, file };
}
