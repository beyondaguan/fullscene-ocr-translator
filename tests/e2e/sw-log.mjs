/**
 * 抓取扩展 Service Worker 的 console / 异常日志（直连 CDP，绕过 Playwright 不暴露 SW 的限制）。
 *
 *   node tests/e2e/sw-log.mjs
 */
const WS_PATH = process.env.FS_WS ?? 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const CDP = process.env.FS_CDP ?? 'http://127.0.0.1:9222';
const list = await (await fetch(`${CDP}/json/list`)).json();
const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js') && !t.url.includes('rollup'));
if (!sw) {
  console.log('[sw-log] 未找到扩展 service worker');
  process.exit(1);
}
console.log('[sw-log] target:', sw.url);

const ws = new WebSocket(sw.webSocketDebuggerUrl, { perMessageDeflate: false });
let nextId = 1;
const pending = new Map();

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    console.log(`[sw:${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    console.log(`[sw:exception] ${d.exception?.description ?? d.text}`);
  }
  if (msg.method === 'Log.entryAdded') {
    console.log(`[sw:log:${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
});

await new Promise((r) => ws.on('open', r));
await send('Runtime.enable');
await send('Log.enable');
console.log('[sw-log] 已订阅日志。现在触发一次翻译（在浏览器里划词点「译」），日志会实时打印。');
console.log('[sw-log] 按 Ctrl+C 结束。');
