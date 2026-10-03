import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * 生成 dist 内的 HTML 入口并拷贝 manifest。
 * Chrome 要求 manifest 位于扩展根目录；popup/sidebar 的 HTML 引用 dist 根上
 * 由 rollup entryFileNames 产出的 popup.js / sidebar.js（相对路径 ../popup.js）。
 */
function copyExtensionAssets(): Plugin {
  // 注意：HTML 由本插件手写生成，Vite 不会自动注入 <link rel="stylesheet">。
  // 因此 CSS 必须输出为固定文件名 style.css，并在此显式引用。
  const html = (title: string, script: string): string => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="../style.css" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${script}"></script>
  </body>
</html>
`;
  const generated: Array<[string, string]> = [
    ['popup/index.html', html('全场景OCR翻译', '../popup.js')],
    ['sidebar/index.html', html('全场景OCR翻译 · 侧栏', '../sidebar.js')],
    ['options/index.html', html('全场景OCR翻译 · 设置', '../options.js')],
  ];
  return {
    name: 'copy-extension-assets',
    closeBundle() {
      // 源 manifest 以「加载源目录」为基准（路径带 dist/ 前缀）；
      // 构建生成的 dist manifest 需去掉 dist/ 前缀（dist 作为扩展根时文件就在根下）。
      const srcManifest = readFileSync(resolve(root, 'manifest.json'), 'utf-8');
      const distManifest = srcManifest.replace(/"dist\//g, '"');
      writeFileSync(resolve(root, 'dist', 'manifest.json'), distManifest, 'utf-8');
      for (const [to, content] of generated) {
        const target = resolve(root, 'dist', to);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf-8');
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // content script 必须是经典脚本（Chrome 不支持 module content script），单独 IIFE 构建
  // 命令：vite build --mode content（在 `npm run build` 中串在主构建之后）
  if (mode === 'content') {
    return {
      build: {
        outDir: 'dist',
        emptyOutDir: false,
        copyPublicDir: false,
        target: 'es2020',
        lib: {
          entry: resolve(root, 'src/content/main.ts'),
          formats: ['iife'],
          name: 'FullSceneContent',
          fileName: () => 'content.js',
        },
      },
    };
  }

  return {
    publicDir: 'public',
    plugins: [react(), copyExtensionAssets()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2022',
      modulePreload: false,
      // 单一 CSS 文件：扩展各页面 HTML 由插件生成，无法依赖 Vite 自动注入 link
      cssCodeSplit: false,
      rollupOptions: {
        input: {
          background: resolve(root, 'src/background/main.ts'),
          popup: resolve(root, 'src/popup/main.tsx'),
          sidebar: resolve(root, 'src/sidebar/main.tsx'),
          options: resolve(root, 'src/options/main.tsx'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: (asset) =>
            asset.name?.endsWith('.css') ? 'style.css' : 'assets/[name]-[hash][extname]',
        },
      },
    },
    worker: { format: 'es' },
  };
});
