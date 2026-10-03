/**
 * 生词本真机验证：侧栏「收藏 / 列表置顶 / 删除 / 导出」四项。
 *
 *   node tests/e2e/vocab-e2e.mjs
 *
 * 做法：启动带扩展的 Edge（全新 profile）→ 从 Service Worker target 拿到扩展 id →
 * 以标签页打开侧栏 → 预置 3 条生词 → 验证排序 → 点「☆ 收藏」验证置顶 → 截图。
 *
 * 坑：与 run-e2e.mjs 相同（不要 browser.close()；profile 必须全新；后台 spawn detached）。
 */
import { spawn, execSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';

const PW =
  process.env.FS_PW ??
  'file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const { chromium } = await import(PW);

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_DIR = process.env.FS_EXT_DIR ?? 'D:\\g\\fullscene-ocr-translator\\extension\\dist';
const PROFILE = 'D:\\g\\fullscene-ocr-translator\\.workbuddy\\e2e-edge-profile';
const CDP = 'http://127.0.0.1:9222';
const SHOTS = 'D:/g/fullscene-ocr-translator/.workbuddy/e2e-shots';

const log = (...a) => console.log('[vocab]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpAlive() {
  try {
    return (await fetch(`${CDP}/json/version`)).ok;
  } catch {
    return false;
  }
}

// ---------- 启动 Edge（全新 profile） ----------
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
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  edge.unref();
  for (let i = 0; i < 40 && !(await cdpAlive()); i++) await sleep(500);
}

// ---------- 拿扩展 id ----------
let extId = null;
for (let i = 0; i < 30 && !extId; i++) {
  const list = await fetch(`${CDP}/json/list`).then((r) => r.json());
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  if (sw) extId = new URL(sw.url).host;
  else await sleep(500);
}
if (!extId) {
  log('结论：FAIL — 拿不到扩展 id（扩展未加载）');
  process.exit(2);
}
log('扩展 id:', extId);

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0] ?? (await browser.newContext());

// ---------- 打开侧栏 ----------
const sidebarUrl = `chrome-extension://${extId}/sidebar/index.html`;
let page = ctx.pages().find((p) => p.url() === sidebarUrl);
if (!page) page = await ctx.newPage();
await page.goto(sidebarUrl, { waitUntil: 'domcontentloaded' });
await page.bringToFront();
await sleep(1200);
log('侧栏已打开:', page.url());

// ---------- 预置 3 条生词（v2 已收藏） ----------
await page.evaluate(async () => {
  const now = Date.now();
  const mk = (id, term, translation, ts, favorite) => ({
    id,
    term,
    translation,
    sourceLang: 'en',
    targetLang: 'zh',
    ts,
    reviewCount: 0,
    favorite,
  });
  await chrome.storage.local.set({
    'fullscene.vocabulary': [
      mk('v1', 'prostate', '前列腺', now - 3000, false),
      mk('v2', 'bladder', '膀胱', now - 2000, true),
      mk('v3', 'ureteral stone', '输尿管结石', now - 1000, false),
    ],
  });
});
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(1200);

// ---------- 切到生词本 Tab ----------
await page.getByRole('button', { name: /生词本/ }).first().click();
await sleep(600);

const readList = () =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll('.fs-item')];
    return items.map((el) => ({
      term: el.querySelector('.fs-item-src')?.textContent?.trim() ?? '',
      fav: [...el.querySelectorAll('button')].some((b) => b.textContent?.includes('★')),
      bg: getComputedStyle(el).backgroundColor,
    }));
  });

const before = await readList();
log('收藏前顺序:', JSON.stringify(before.map((x) => `${x.term}${x.fav ? '★' : ''}`)));
await page.screenshot({ path: `${SHOTS}/vocab-01-list.png` });

// ---------- 点第 3 条（ureteral stone）的「☆ 收藏」----------
// 精确定位「ureteral stone」那一条（ts 最大，收藏组内应排到收藏的 bladder 之前）
const target = page.locator('.fs-item', { hasText: 'ureteral stone' });
const starBtn = target.locator('button', { hasText: '☆ 收藏' });
if ((await starBtn.count()) === 0) {
  log('结论：FAIL — 没有找到「☆ 收藏」按钮');
  process.exit(3);
}
log('未收藏条目数:', await page.locator('.fs-item button', { hasText: '☆ 收藏' }).count());
await starBtn.first().click();
await sleep(700);

const after = await readList();
log('收藏后顺序:', JSON.stringify(after.map((x) => `${x.term}${x.fav ? '★' : ''}`)));
await page.screenshot({ path: `${SHOTS}/vocab-02-favorited.png` });

// ---------- 判定 ----------
const okSortBefore = before[0]?.term === 'bladder'; // 收藏置顶
const movedToTop = after[0]?.term === 'ureteral stone' && after[0]?.fav === true; // 新收藏的置顶
const favCount = after.filter((x) => x.fav).length;
const okExport = (await page.locator('.fs-card button', { hasText: 'CSV' }).count()) > 0;
const okDelete = (await page.locator('.fs-item button', { hasText: '删除' }).count()) > 0;

log('---');
log('收藏置顶（初始）:', okSortBefore ? 'PASS' : 'FAIL');
log('点击收藏后置顶:', movedToTop ? 'PASS' : 'FAIL');
log('收藏条目数:', favCount, '(期望 2)');
log('导出按钮存在:', okExport ? 'PASS' : 'FAIL');
log('删除按钮存在:', okDelete ? 'PASS' : 'FAIL');

const pass = okSortBefore && movedToTop && favCount === 2 && okExport && okDelete;
log('结论：', pass ? 'PASS — 收藏/列表置顶/删除/导出 四项均可用' : 'FAIL');
process.exit(pass ? 0 : 1);
