/**
 * Native Messaging 插件端桥：connectNative 建立持久连接，
 * port 收发 OCR/翻译请求与结果。
 *
 * 协议对齐：请求/响应 schema 与 Rust 端 types.rs 完全一致（见 types/message.ts）。
 * 由于 host 单线程按发送顺序处理并回写响应，本桥用 FIFO 队列按到达顺序关联
 * 请求与响应（不再依赖 timestamp）。
 */
import type { CaptureTarget, NmRequest, NmResponse, OcrLine } from '../types/message';
import { isError } from '../types/message';
import { NM_HOST } from './protocol';

/** 待处理请求：resolve 在收到响应时调用，reject 在超时/断线时调用 */
interface Pending {
  resolve: (r: NmResponse) => void;
  reject: (e: Error) => void;
}

/** chrome.runtime 最小依赖（便于注入 mock） */
export interface ChromeRuntimeApi {
  connectNative(host: string): ChromePort;
  lastError?: { message?: string };
}

/** chrome.runtime.Port 最小契约 */
export interface ChromePort {
  postMessage(msg: unknown): void;
  onMessage: {
    addListener(cb: (msg: unknown) => void): void;
    removeListener(cb: (msg: unknown) => void): void;
  };
  onDisconnect: {
    addListener(cb: () => void): void;
    removeListener(cb: () => void): void;
  };
  disconnect(): void;
}

let port: ChromePort | null = null;
/** 按到达顺序关联响应的 FIFO 队列 */
let pending: Pending[] = [];

/** 注入 chrome.runtime；不注入则取全局 */
function chromeRuntime(): ChromeRuntimeApi | undefined {
  const api = (globalThis as unknown as { chrome?: { runtime?: ChromeRuntimeApi } }).chrome;
  return api?.runtime;
}

/**
 * 建立到 Rust host 的 Native Messaging 连接。
 * 环境不可用（非浏览器）时抛明确错误。
 */
export function connect(): ChromePort {
  const runtime = chromeRuntime();
  if (!runtime?.connectNative) throw new Error('chrome.runtime.connectNative 不可用');

  port = runtime.connectNative(NM_HOST);
  port.onMessage.addListener((msg: unknown) => {
    // 严格 FIFO：响应按发送顺序返回，取最早待处理项
    const next = pending.shift();
    if (next) next.resolve(msg as NmResponse);
  });
  port.onDisconnect.addListener(() => {
    // host 断开：拒绝所有待处理请求，清空队列
    const waiting = pending;
    pending = [];
    const err = new Error('Native Messaging 连接已断开');
    for (const p of waiting) p.reject(err);
  });

  return port;
}

/**
 * 发送请求并等待顺序到达的响应（FIFO 关联，无 timestamp）。
 * 超时 30s 未响应则拒绝。
 */
export function sendMessage(req: NmRequest): Promise<NmResponse> {
  // connect 失败（环境不可用）需转为 rejected promise，而非同步抛出
  try {
    if (!port) connect();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  return new Promise<NmResponse>((resolve, reject) => {
    const item: Pending = { resolve, reject };
    pending.push(item);
    try {
      port?.postMessage(req);
    } catch (error) {
      // 发送失败：移除此项并拒绝
      const i = pending.indexOf(item);
      if (i !== -1) pending.splice(i, 1);
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    setTimeout(() => {
      const i = pending.indexOf(item);
      if (i !== -1) {
        pending.splice(i, 1);
        reject(new Error(`Native Messaging 请求超时（type=${req.type}）`));
      }
    }, 30_000);
  });
}

/** 断开连接 */
export function disconnect(): void {
  const waiting = pending;
  pending = [];
  const err = new Error('Native Messaging 连接已断开');
  for (const p of waiting) p.reject(err);
  if (port) {
    port.disconnect();
    port = null;
  }
}

/** 断线重连：先断后连 */
export function reconnect(): void {
  disconnect();
  connect();
}

/** 当前待处理请求数（测试用） */
export function pendingCount(): number {
  return pending.length;
}

/**
 * 端到端截图翻译管线：截图 → OCR → 翻译。
 * @param target 截图目标（默认主显示器）
 * @param dst 目标语言（默认中文）
 * @returns OCR 原文与译文
 */
export async function captureTranslate(
  target: CaptureTarget = { mode: 'Primary' },
  dst = 'zh',
): Promise<{ ocrText: string; translation: string }> {
  // 1. 截图
  const cap = await sendMessage({ type: 'Capture', target });
  if (isError(cap)) throw new Error(`截图失败：${cap.message}`);
  if (cap.type !== 'Captured') throw new Error(`截图失败：意外响应 ${cap.type}`);

  // 2. OCR（按 image_id 取图）
  const ocr = await sendMessage({ type: 'Ocr', image_id: cap.image_id });
  if (isError(ocr)) throw new Error(`识别失败：${ocr.message}`);
  if (ocr.type !== 'OcrResult') throw new Error(`识别失败：意外响应 ${ocr.type}`);

  const ocrText = ocr.lines.map((l: OcrLine) => l.text).join('\n');
  if (!ocrText.trim()) return { ocrText: '', translation: '' };

  // 3. 翻译（src=auto 让模型自动识别源语言）
  const tr = await sendMessage({ type: 'Translate', text: ocrText, src: 'auto', dst });
  if (isError(tr)) throw new Error(`翻译失败：${tr.message}`);
  if (tr.type !== 'Translation') throw new Error(`翻译失败：意外响应 ${tr.type}`);

  return { ocrText, translation: tr.text };
}

/** 仅截图识别（不翻译），返回 OCR 行 */
export async function captureOcr(target: CaptureTarget = { mode: 'Primary' }): Promise<OcrLine[]> {
  const cap = await sendMessage({ type: 'Capture', target });
  if (isError(cap)) throw new Error(`截图失败：${cap.message}`);
  if (cap.type !== 'Captured') throw new Error(`截图失败：意外响应 ${cap.type}`);

  const ocr = await sendMessage({ type: 'Ocr', image_id: cap.image_id });
  if (isError(ocr)) throw new Error(`识别失败：${ocr.message}`);
  if (ocr.type !== 'OcrResult') throw new Error(`识别失败：意外响应 ${ocr.type}`);
  return ocr.lines;
}

/**
 * 交互式框选截图翻译：请求 Rust 壳弹出框选遮罩，用户拖出区域后截图 → OCR → 翻译。
 * 与 [`captureTranslate`] 的区别：截图目标由用户在屏幕上实时框选，而非预指定区域。
 */
export async function selectCaptureTranslate(dst = 'zh'): Promise<{ ocrText: string; translation: string }> {
  // 1. 请求框选：Rust 壳弹遮罩，用户拖出区域后自动截图并存缓存
  const cap = await sendMessage({ type: 'SelectCapture' });
  if (isError(cap)) throw new Error(`框选截图失败：${cap.message}`);
  if (cap.type !== 'Captured') throw new Error(`框选截图失败：意外响应 ${cap.type}`);

  // 2. OCR（按 image_id 取图）
  const ocr = await sendMessage({ type: 'Ocr', image_id: cap.image_id });
  if (isError(ocr)) throw new Error(`识别失败：${ocr.message}`);
  if (ocr.type !== 'OcrResult') throw new Error(`识别失败：意外响应 ${ocr.type}`);

  const ocrText = ocr.lines.map((l: OcrLine) => l.text).join('\n');
  if (!ocrText.trim()) return { ocrText: '', translation: '' };

  // 3. 翻译（src=auto 让模型自动识别源语言）
  const tr = await sendMessage({ type: 'Translate', text: ocrText, src: 'auto', dst });
  if (isError(tr)) throw new Error(`翻译失败：${tr.message}`);
  if (tr.type !== 'Translation') throw new Error(`翻译失败：意外响应 ${tr.type}`);

  return { ocrText, translation: tr.text };
}