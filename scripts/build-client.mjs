// 构建浏览器半边。
//
// DSH 的 web 加载器用 window.__ModuleLoader__.load({ id, factory }) 登记 client bundle，
// 求值时调用 factory(require)：模块解析函数由加载器注入（没有全局 require），返回值
// 就是插件模块的导出。官方 dsh-context 由 tsdown 的 banner/intro/footer 生成同一形态，
// 所以这里打 CJS（require 留外部），外面再套这层 factory。
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const dir = path.resolve(root, '..');

await build({
  entryPoints: [path.join(dir, 'src/client.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  minify: true,
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  outfile: path.join(dir, '.client.build.cjs'),
  logLevel: 'warning',
});

const body = await readFile(path.join(dir, '.client.build.cjs'), 'utf8');

// 与官方 tsdown 的 banner / intro / footer 逐字一致
const wrapped = `window.__ModuleLoader__.load({ id: "dsh-plugin-agentflow", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
${body}return module.exports; } });
`;

await mkdir(path.join(dir, 'lib'), { recursive: true });
await writeFile(path.join(dir, 'lib/client.js'), wrapped);
console.log(`lib/client.js  ${(wrapped.length / 1024).toFixed(1)} KB`);
