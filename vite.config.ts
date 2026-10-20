import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * 客户端半身的构建配置。
 *
 * 产物是单文件 CJS `.client.build.cjs`（由 scripts/build-client.mjs 套上
 * window.__ModuleLoader__.load 的 wrapper 后写入 lib/client.js），所以：
 *   - react / react-dom 由宿主提供，一律 external，靠 wrapper 注入的 require 解析
 *   - @deepseek-ai/* 是宿主侧服务包，同样 external
 *   - CSS 全部以 `?inline` 字符串进 JS（画布与 xyflow 的样式由 CanvasHost 注入），
 *     因此不会有额外的 .css 文件
 *   - 输出目录就是仓库根：文件名已带点前缀，并被 .gitignore 忽略
 */
export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  // 宿主浏览器环境里没有 process，antd 等库里的 process.env.NODE_ENV 必须在构建期替换掉，
  // 否则 bundle 求值第一行就 ReferenceError（library 模式 Vite 默认不替换）。
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: path.join(root, 'src/index.tsx'),
      formats: ['cjs'],
      // cjs + package.json "type": "module" → `.client.build.cjs`
      fileName: '.client.build',
    },
    outDir: root,
    // 输出目录就是仓库根，绝不能清空
    emptyOutDir: false,
    cssCodeSplit: false,
    minify: true,
    sourcemap: false,
    target: 'es2022',
    reportCompressedSize: false,
    rolldownOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', /^@deepseek-ai\//],
    },
  },
});
