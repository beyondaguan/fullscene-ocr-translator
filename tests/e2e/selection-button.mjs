/**
 * 真机端到端验证：划词 → 点蓝色「译」按钮 → 应弹出完整翻译浮窗。
 *
 * 运行方式（需先启动带扩展的 Edge）：
 *   msedge.exe --remote-debugging-port=9222 --user-data-dir=<临时目录> \
 *     --load-extension="D:\g\fullscene-ocr-translator\extension\dist" <测试页面>
 *   NODE_PATH=<workspace>/node_modules node tests/e2e/selection-button.mjs
 *
 * 判定标准（全部满足才算通过）：
 *   1. 划词后出现 .fullscene-selection-button
 *   2. 点击（真实鼠标 down/up）后按钮不跳位、不消失
 *   3. 出现 .fullscene-floating-panel（完整浮窗），且内含 .fs-out 译文区
 */
// playwright-core 装在隔离工作区，ESM 不认 NODE_PATH，故用可配置的绝对路径导入。
const PW = process.env.FS_PW ?? 'file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const { chromium } = await import(PW);

const CDP = process.env.FS_CDP ?? 'http://127.0.0.1:9222';
const PAGE_URL = process.env.FS_PAGE ?? 'http://127.0.0.1:8931/page.html';
const SHOT_DIR = process.env.FS_SHOT_DIR ?? 'D:/g/fullscene-ocr-translator/.workbuddy/e2e-shots';

const BTN = '.fullscene-selection-button';
const PANEL = '.fullscene-floating-panel';

const log = (...a) => console.log('[e2e]', ...a);

async function findOrCreatePage(browser) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().startsWith('http://127.0.0.1:8931')) return p;
    }
  }
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  return page;
}

const browser = await chromium.connectOverCDP(CDP);
log('connected:', browser.version?.() ?? '(cdp)');

const page = await findOrCreatePage(browser);
await page.bringToFront();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.waitForTimeout(1200); // 等 content script 注入完成
log('url:', page.url());

// ---------- 1. 真实鼠标划词 ----------
const box = await page.locator('#target').boundingBox();
log('target box:', JSON.stringify(box));

await page.mouse.move(box.x + 6, box.y + 18);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(box.x + 6 + (box.width * 0.62 * i) / 12, box.y + 18);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(400);

const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
log('selected text:', JSON.stringify(selected));

const btnCount = await page.locator(BTN).count();
log('button count after selection:', btnCount);
if (btnCount === 0) {
  await page.screenshot({ path: `${SHOT_DIR}/01-no-button.png` });
  log('FAIL: 划词后未出现「译」按钮');
  await browser.close();
  process.exit(2);
}

const beforeBox = await page.locator(BTN).boundingBox();
const beforeText = await page.locator(BTN).textContent();
log('button before click:', JSON.stringify(beforeBox), JSON.stringify(beforeText));
await page.screenshot({ path: `${SHOT_DIR}/01-button.png` });

// ---------- 2. 真实点击「译」 ----------
const cx = beforeBox.x + beforeBox.width / 2;
const cy = beforeBox.y + beforeBox.height / 2;
log('click at:', cx, cy);
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(60);
const midText = await page.locator(BTN).count().then(async (n) => (n ? await page.locator(BTN).textContent() : '(gone)'));
log('button text right after mousedown:', JSON.stringify(midText));
await page.mouse.up();
await page.waitForTimeout(120);

const afterBox = (await page.locator(BTN).count()) ? await page.locator(BTN).boundingBox() : null;
const afterText = (await page.locator(BTN).count()) ? await page.locator(BTN).textContent() : '(gone)';
log('button after click:', JSON.stringify(afterBox), JSON.stringify(afterText));
await page.screenshot({ path: `${SHOT_DIR}/02-after-click.png` });

// ---------- 3. 等待浮窗 ----------
let panelOk = false;
try {
  await page.waitForSelector(PANEL, { timeout: 12000 });
  panelOk = true;
} catch {
  panelOk = false;
}
log('panel appeared:', panelOk);

let outText = '';
if (panelOk) {
  await page.waitForTimeout(600);
  outText = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    if (!host?.shadowRoot) return '(no shadow)';
    const out = host.shadowRoot.querySelector('.fs-out');
    return (out?.textContent ?? '(empty)').slice(0, 200);
  }, PANEL);
  log('panel output:', JSON.stringify(outText));
}
await page.screenshot({ path: `${SHOT_DIR}/03-panel.png` });

// 错误提示条（失败可见化）
const errToast = await page.evaluate(() => {
  const el = document.querySelector('.fullscene-error, .fullscene-toast');
  return el ? el.textContent : null;
});
log('error toast:', JSON.stringify(errToast));
log('console errors:', JSON.stringify(consoleErrors.slice(0, 10), null, 2));

const verdict = {
  selected: selected.trim().length > 0,
  buttonShown: btnCount > 0,
  buttonStable: afterBox !== null && Math.abs(afterBox.x - beforeBox.x) < 2 && Math.abs(afterBox.y - beforeBox.y) < 2,
  translateStarted: midText === '翻译中…' || afterText === '翻译中…' || afterText === '(gone)' || panelOk,
  panelShown: panelOk,
  outText,
  errToast,
};
log('VERDICT:', JSON.stringify(verdict, null, 2));

await browser.close();
process.exit(verdict.panelShown ? 0 : 3);
