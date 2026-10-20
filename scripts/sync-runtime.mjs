#!/usr/bin/env node
// sync-runtime.mjs —— 把本机 AgentFlow 引擎快照进插件的 runtime/。
//
//   npm run sync
//   AGENTFLOW_SRC=~/src/agent-flow npm run sync
//
// 只收运行时真正需要的文件：
//   - 顶层 *.mjs（server / engine / llm / boards / preset-gen …）
//   - index.html（单文件旧版前端兜底）
//   - web/dist/**（React 版前端构建产物）
// 不收 data/（运行时数据）、node_modules/、test/、web/src/。
//
// 每次清空重建，保证 runtime/ 与引擎来源一一对应，不残留旧文件。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'runtime');
const SRC = path.resolve(process.env.AGENTFLOW_SRC || path.join(os.homedir(), '.dsh', 'agent-flow'));

/** 少了一个就跑不起来，宁可同步失败也别生成半残的 runtime */
const REQUIRED = ['server.mjs', 'engine.mjs', 'boards.mjs', 'llm.mjs', 'index.html', 'web/dist/index.html'];

function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

/** 递归统计文件数 / 字节数 */
async function measure(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await measure(at);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += (await fs.stat(at)).size;
    }
  }
  return { files, bytes };
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  for (const name of REQUIRED) {
    if (!(await exists(path.join(SRC, name)))) {
      throw new Error(`引擎缺少必需文件：${path.join(SRC, name)}（用 AGENTFLOW_SRC 指定引擎目录）`);
    }
  }

  // 清空重建：runtime/ 是生成物，不手改
  await fs.rm(DEST, { recursive: true, force: true });
  await fs.mkdir(DEST, { recursive: true });

  const mjs = (await fs.readdir(SRC))
    .filter((name) => name.endsWith('.mjs') && !name.startsWith('.'))
    .sort();
  for (const name of mjs) {
    await fs.copyFile(path.join(SRC, name), path.join(DEST, name));
  }
  await fs.copyFile(path.join(SRC, 'index.html'), path.join(DEST, 'index.html'));
  await fs.cp(path.join(SRC, 'web', 'dist'), path.join(DEST, 'web', 'dist'), { recursive: true });

  const stats = await measure(DEST);
  console.log(`runtime 已生成：${DEST}`);
  console.log(`  来源：${SRC}`);
  console.log(`  引擎：${mjs.length} 个 .mjs`);
  console.log('  前端：index.html + web/dist/**');
  console.log(`  合计：${stats.files} 个文件，${mb(stats.bytes)}`);
}

main().catch((err) => {
  console.error('同步失败：' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
