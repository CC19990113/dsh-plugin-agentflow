// 构建浏览器半边。
//
// DSH 的 web 加载器用 window.__ModuleLoader__.load({ id, factory }) 登记 client bundle，
// 求值时调用 factory(require)：模块解析函数由加载器注入（没有全局 require），返回值
// 就是插件模块的导出。官方 dsh-context 由 tsdown 的 banner/intro/footer 生成同一形态，
// 所以这里让 Vite 打 CJS（react 等留 external），外面再套这层 factory。
//
// 构建细节在 vite.config.ts：单入口 src/index.tsx、lib cjs、产物 .client.build.cjs。
// 本脚本只负责调用 Vite API、套 wrapper、写 lib/client.js。
import { gzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createLogger } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(root, '..');
const bundlePath = path.join(dir, '.client.build.cjs');

// 产物直接落在仓库根（与旧 esbuild 一致）；Vite 对 outDir === root 总会提示一句，
// 而 emptyOutDir 已关、不会覆盖源码 —— 过滤这一条，别让有用告警被它淹没。
const logger = createLogger('warn');
const warn = logger.warn.bind(logger);
logger.warn = (msg, options) => {
  if (typeof msg === 'string' && msg.includes('build.outDir must not be the same directory of root')) return;
  warn(msg, options);
};

await build({
  configFile: path.join(dir, 'vite.config.ts'),
  logLevel: 'warn',
  customLogger: logger,
});

const body = await readFile(bundlePath, 'utf8');

// 与官方 tsdown 的 banner / intro / footer 逐字一致
const wrapped = `window.__ModuleLoader__.load({ id: "dsh-plugin-agentflow", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
${body}return module.exports; } });
`;

await mkdir(path.join(dir, 'lib'), { recursive: true });
await writeFile(path.join(dir, 'lib/client.js'), wrapped);

const bytes = Buffer.byteLength(wrapped);
const gzipped = gzipSync(wrapped).length;
console.log(`lib/client.js  ${(bytes / 1024).toFixed(1)} KB（gzip ${(gzipped / 1024).toFixed(1)} KB）`);
