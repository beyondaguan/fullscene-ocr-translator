/**
 * shared-ui 前端渲染探针：直接打开 dev server（http://localhost:1420），
 * 读取 DOM 文本与关键节点，确认 React 应用真的挂载并渲染出 AppShell。
 *
 *   node tests/e2e/shared-ui-probe.mjs
 *
 * 注意：这里没有 Tauri IPC，若 UI 依赖 invoke 拿配置会走容错分支；
 * 目的是验证「前端能挂载 + 骨架可见」，Tauri 内的真实渲染另由窗口截图佐证。
 */
const PW =
  process.env.FS_PW ??
  'file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const { chromium } = await import(PW);

const SHOTS = 'D:/g/fullscene-ocr-translator/.workbuddy/m0-shots';
const URL_ = 'http://localhost:1420/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({
  executablePath: EDGE,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.goto(URL_, { waitUntil: 'networkidle' });
await new Promise((r) => setTimeout(r, 1500));

const info = await page.evaluate(() => ({
  title: document.title,
  bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
  nodeCount: document.querySelectorAll('*').length,
  hasRoot: !!document.querySelector('#root')?.firstElementChild,
  buttons: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 20),
  hasTauri: typeof window.__TAURI_INTERNALS__ !== 'undefined',
}));

console.log('[shared-ui] title =', info.title);
console.log('[shared-ui] root 已挂载 =', info.hasRoot, '| 节点数 =', info.nodeCount);
console.log('[shared-ui] Tauri IPC 可用 =', info.hasTauri);
console.log('[shared-ui] 按钮 =', JSON.stringify(info.buttons));
console.log('[shared-ui] 文本 =', JSON.stringify(info.bodyText));
console.log('[shared-ui] 页面错误 =', errors.length ? JSON.stringify(errors.slice(0, 5)) : '(无)');

await page.screenshot({ path: `${SHOTS}/m0-shared-ui.png` });
await browser.close();
process.exit(info.hasRoot && info.nodeCount > 20 ? 0 : 1);
