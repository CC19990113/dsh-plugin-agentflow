// skills.mjs —— 扫描并加载 skill。
//
// skill 就是一个目录，里面有 SKILL.md：
//   ---
//   name: code-review
//   description: 审查 diff 的清单
//   ---
//   正文……
//
// 这里只做两件事：列出有哪些 skill、把某个 skill 的正文读出来拼进 prompt。

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 默认扫描的目录：本机的 + 项目自带的 */
export function defaultSkillDirs() {
  return [
    path.join(ROOT, 'skills'),
    path.join(os.homedir(), '.dsh', 'skills'),
  ];
}

/** 极简 frontmatter 解析：认 --- 包起来的那段 key: value，支持 > / | 块标量 */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const lines = m[1].split(/\r?\n/);
  const meta = {};

  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();

    // 块标量：description: > 后面跟一段缩进的多行文字
    if (/^[>|][+-]?$/.test(val)) {
      const folded = val.startsWith('>');
      const buf = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j];
        if (/^\s+\S/.test(line)) buf.push(line.trim());
        else if (/^\s*$/.test(line)) buf.push('');
        else break;
      }
      i = j - 1;
      val = folded ? buf.join(' ').replace(/\s+/g, ' ').trim() : buf.join('\n').trim();
    }

    // 去掉成对的引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * 列出所有 skill。
 * @returns [{ name, description, path, dir }]
 */
export async function listSkills(dirs) {
  const scan = dirs && dirs.length ? dirs : defaultSkillDirs();
  const out = [];
  const seen = new Set();

  for (const dir of scan) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在就跳过，不算错
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const skillDir = path.join(dir, ent.name);
      const file = path.join(skillDir, 'SKILL.md');
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { meta } = parseFrontmatter(text);
      const name = meta.name || ent.name;
      if (seen.has(name)) continue; // 同名只留第一个（项目目录优先）
      seen.add(name);
      out.push({
        name,
        description: meta.description || '',
        path: file,
        dir: skillDir,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 读某个 skill 的正文（去掉 frontmatter），找不到返回 null */
export async function loadSkillBody(name, dirs) {
  const all = await listSkills(dirs);
  const hit = all.find((s) => s.name === name);
  if (!hit) return null;
  const text = await fs.readFile(hit.path, 'utf8');
  return parseFrontmatter(text).body.trim();
}

/**
 * 把节点挂载的 skills 拼成一段 system 提示。
 * 没有任何 skill 时返回空串。
 */
export async function composeSkillPrompt(names, dirs) {
  if (!Array.isArray(names) || !names.length) return '';
  const parts = [];
  for (const n of names) {
    const body = await loadSkillBody(n, dirs);
    if (!body) {
      parts.push(`【技能 ${n}】未找到，忽略。`);
      continue;
    }
    parts.push(`【技能：${n}】\n${body}`);
  }
  return parts.join('\n\n');
}
