/**
 * 一体化真机端到端：启动带扩展的 Edge（未打包）→ 订阅 Service Worker 日志 →
 * 真实鼠标划词 → 真实点击蓝色「译」→ 判定是否弹出完整浮窗 → 输出诊断结论 + 截图。
 *
 *   node tests/e2e/run-e2e.mjs
 *
 * 环境变量：
 *   FS_ROUNDS=3      连续跑几轮（第 1 轮是冷启动，最能暴露问题）
 *   FS_KEEP_EDGE=1   结束后保留浏览器窗口
 *   FS_EXT_DIR       扩展目录（默认 extension/dist）
 *
 * 坑记录：
 *   - 不能调 browser.close()：connectOverCDP 下它会把整台 Edge 一起关掉。
 *   - 每轮必须用全新 profile：复用旧 profile 时 Edge 不再加载 --load-extension 的扩展。
 *   - 后台进程要用 spawn detached，否则随 shell 结束被回收。
 */
import { spawn, execSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';

const WS_PATH = process.env.FS_WS ?? 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const PW = process.env.FS_PW ?? 'file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);
const { chromium } = await import(PW);

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_DIR = process.env.FS_EXT_DIR ?? 'D:\\g\\fullscene-ocr-translator\\extension\\dist';
const PROFILE = 'D:\\g\\fullscene-ocr-translator\\.workbuddy\\e2e-edge-profile';
const CDP = 'http://127.0.0.1:9222';
const PAGE_URL = 'http://127.0.0.1:8931/page.html';
const SHOTS = 'D:/g/fullscene-ocr-translator/.workbuddy/e2e-shots';
const BTN = '.fullscene-selection-button';
const PANEL = '.fullscene-floating-panel';
const ROUNDS = Number(process.env.FS_ROUNDS ?? 3);

const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpAlive() {
  try {
    return (await fetch(`${CDP}/json/version`)).ok;
  } catch {
    return false;
  }
}

// ---------- 1. 启动 Edge（全新 profile） ----------
try {
  execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'msedge.exe\'\\" | Where-Object { $_.CommandLine -like \'*e2e-edge-profile*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
    { stdio: 'ignore' },
  );
  await sleep(1500);
  if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });
} catch {
  /* 无残留 */
}

if (!(await cdpAlive())) {
  log('启动 Edge（加载扩展', EXT_DIR, '）...');
  const edge = spawn(
    EDGE,
    [
      '--remote-debugging-port=9222',
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=ExtensionsToolbarMenu',
      PAGE_URL,
    ],
    { detached: true, stdio: 'ignore' },
  );
  edge.unref();
  for (let i = 0; i < 40 && !(await cdpAlive()); i++) await sleep(500);
}

// ---------- 2. 订阅 Service Worker 日志 ----------
const swLogs = [];
function attachSwLog() {
  return fetch(`${CDP}/json/list`)
    .then((r) => r.json())
    .then((list) => {
      const sw = list.find(
        (t) => t.type === 'service_worker' && t.url.includes('background.js') && !t.url.includes('rollup'),
      );
      if (!sw) return null;
      const ws = new WebSocket(sw.webSocketDebuggerUrl, { perMessageDeflate: false });
      let id = 1;
      const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }));
      ws.on('open', () => {
        send('Runtime.enable');
        send('Log.enable');
      });
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.method === 'Runtime.consoleAPICalled') {
          swLogs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
        } else if (m.method === 'Runtime.exceptionThrown') {
          swLogs.push(`[exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
        } else if (m.method === 'Log.entryAdded') {
          swLogs.push(`[${m.params.entry.level}] ${m.params.entry.text}`);
        }
      });
      return ws;
    });
}

let swWs = null;
for (let i = 0; i < 40 && !swWs; i++) {
  swWs = await attachSwLog();
  if (!swWs) await sleep(500);
}
log('SW 日志订阅:', swWs ? '已连接' : '未连接');

// ---------- 3. 真实交互 ----------
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
let page = ctx.pages().find((p) => p.url().startsWith('http://127.0.0.1:8931'));
if (!page) {
  page = await ctx.newPage();
  await page.goto(PAGE_URL, { waitUntil: 'load' });
}
await page.bringToFront();
await sleep(1500);

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`);
});

// 记录所有 fullscene 元素的增删时间线
await page.evaluate(() => {
  window.__fsLog = [];
  window.__t0 = Date.now();
  new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) window.__fsLog.push([Date.now() - window.__t0, '+', String(n.className), (n.textContent || '').slice(0, 24)]);
      });
      m.removedNodes.forEach((n) => {
        if (n.nodeType === 1) window.__fsLog.push([Date.now() - window.__t0, '-', String(n.className), (n.textContent || '').slice(0, 24)]);
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
});

const results = [];

for (let round = 1; round <= ROUNDS; round++) {
  log(`\n----- 第 ${round} 轮 -----`);
  // 关掉上一轮的浮窗（Esc + 强制移除），并点空白处清空选区。
  // 不这么做的话浮窗会盖住拖拽起点，鼠标按下落在面板上 → 选不中文字 → 误判"没按钮"。
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    window.__fsLog = [];
    window.__t0 = Date.now();
    document.querySelectorAll('.fullscene-floating-panel').forEach((el) => el.remove());
    document.querySelectorAll('.fullscene-selection-button').forEach((el) => el.remove());
  });
  await page.locator('h1').click();
  await sleep(400);

  // 奇数轮划第一段、偶数轮划第二段，避免总是从同一坐标起拖
  const sel = round % 2 === 1 ? '#target' : '#other';
  const box = await page.locator(sel).boundingBox();
  await page.mouse.move(box.x + 6, box.y + 18);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + 6 + (box.width * 0.62 * i) / 12, box.y + 18);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(400);

  const btnCount = await page.locator(BTN).count();
  if (btnCount === 0) {
    log('FAIL：划词后没有出现「译」按钮');
    results.push({ round, ok: false, reason: 'no-button' });
    continue;
  }
  const beforeBox = await page.locator(BTN).boundingBox();
  if (round === 1) await page.screenshot({ path: `${SHOTS}/01-button.png` });

  const tClick = Date.now();
  await page.mouse.move(beforeBox.x + beforeBox.width / 2, beforeBox.y + beforeBox.height / 2);
  await page.mouse.down();
  await sleep(80);
  const midText = await page.locator(BTN).textContent().catch(() => '(gone)');
  await page.mouse.up();
  log('按下后按钮文案:', JSON.stringify(midText));

  let panelShown = false;
  let outText = '';
  let toastText = null;
  const probe = async () => {
    const r = await page.evaluate(
      ([panelSel]) => {
        const host = document.querySelector(panelSel);
        let out = '';
        if (host?.shadowRoot) {
          const o = host.shadowRoot.querySelector('.fs-out');
          out = (o?.textContent ?? '').trim().slice(0, 120);
        }
        const toast = document.querySelector('.fullscene-tooltip');
        return { panel: !!host, out, toast: toast?.textContent?.trim() ?? null };
      },
      [PANEL],
    );
    if (r.panel) {
      panelShown = true;
      outText = r.out;
    }
    if (r.toast) toastText = r.toast;
    return panelShown || toastText !== null;
  };

  for (let i = 0; i < 60; i++) {
    if (await probe()) break;
    await sleep(250);
  }
  if (!panelShown && !toastText) await sleep(2000);
  await probe();

  const stuckText = (await page.locator(BTN).count()) ? await page.locator(BTN).textContent() : '(gone)';
  const timeline = await page.evaluate(() => window.__fsLog ?? []);
  if (round === 1) await page.screenshot({ path: `${SHOTS}/02-after-click.png` });

  log('浮窗出现:', panelShown, '| 耗时:', Date.now() - tClick, 'ms');
  log('译文:', JSON.stringify(outText));
  log('按钮最终文案:', JSON.stringify(stuckText), '| 提示条:', JSON.stringify(toastText));
  log('DOM 时间线:', JSON.stringify(timeline.slice(0, 20)));
  results.push({ round, ok: panelShown, ms: Date.now() - tClick, outText, toastText, stuckText });
}

log('\n=== 汇总 ===');
for (const r of results) log(`第 ${r.round} 轮: ${r.ok ? 'PASS' : 'FAIL'} ${r.ms ?? ''}ms ${r.reason ?? ''}`);
log('SW 日志:', swLogs.length ? JSON.stringify(swLogs.slice(0, 20), null, 2) : '(无)');
log('页面错误:', pageErrors.length ? JSON.stringify(pageErrors.slice(0, 10), null, 2) : '(无)');

// 不调 browser.close()：那会关掉整台 Edge
if (swWs) swWs.close();
process.exit(results.every((r) => r.ok) ? 0 : 3);
