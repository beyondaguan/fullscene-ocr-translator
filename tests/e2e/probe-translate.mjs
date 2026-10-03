/**
 * 探针：在扩展自身页面上下文直接调用 background 的 translate 消息，
 * 拿到真实返回/错误（含耗时），用于定位「点了没反应」的下游原因。
 *
 *   node tests/e2e/probe-translate.mjs
 */
const PW = process.env.FS_PW ?? 'file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const { chromium } = await import(PW);

const CDP = process.env.FS_CDP ?? 'http://127.0.0.1:9222';
const EXT_ID = process.env.FS_EXT_ID ?? '';

const browser = await chromium.connectOverCDP(CDP);

// 找出扩展 id：从已打开的 service worker 目标里匹配
const list = await (await fetch(`${CDP}/json/list`)).json();
const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js') && !t.url.includes('rollup'));
const id = EXT_ID || sw?.url.split('/')[2];
console.log('[probe] extension id:', id);

const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/options/index.html`, { waitUntil: 'load' });
console.log('[probe] options page:', page.url());

const probes = [
  { name: 'translate(en→zh)', msg: { type: 'translate', text: 'hello world', sourceLang: 'auto', targetLang: 'zh-CN' } },
  { name: 'translate(zh→en)', msg: { type: 'translate', text: '你好世界', sourceLang: 'zh-CN', targetLang: 'en' } },
];

for (const p of probes) {
  const started = Date.now();
  const r = await page.evaluate(
    ([msg, waitMs]) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ status: 'TIMEOUT', waitMs }), waitMs);
        chrome.runtime
          .sendMessage(msg)
          .then((resp) => {
            clearTimeout(timer);
            resolve({ status: 'OK', resp });
          })
          .catch((err) => {
            clearTimeout(timer);
            resolve({ status: 'ERROR', error: String(err?.message ?? err) });
          });
      }),
    [p.msg, 30000],
  );
  console.log(`[probe] ${p.name} -> ${Date.now() - started}ms`, JSON.stringify(r));
}

await page.close();
await browser.close();
