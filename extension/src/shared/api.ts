/**
 * 扩展端 API 层：封装 popup / sidebar / content 与 background 的 chrome.runtime 通信。
 * 消息契约与 background/main.ts 的监听器一一对应。
 */
import type { CaptureTarget } from '../types/message';
import type { TranslationResult } from '../types/engine';

/** 通用响应包装（background 侧 sendResponse 的标准形状） */
export interface ApiResponse<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** 翻译请求 */
export interface TranslateRequest {
  text: string;
  sourceLang?: string;
  targetLang?: string;
  engine?: string;
}

/** 截图翻译请求 */
export interface CaptureTranslateRequest {
  target?: CaptureTarget;
  dst?: string;
}

/**
 * 翻译文本（走 background 的引擎路由）。
 * 返回 TranslationResult；失败时抛 Error。
 */
export async function apiTranslate(req: TranslateRequest): Promise<TranslationResult> {
  const resp = (await chrome.runtime.sendMessage({ type: 'translate', ...req })) as
    | { ok: true; translation: string; engine: string }
    | { ok: false; error: string }
    | undefined;
  if (!resp?.ok) throw new Error(resp?.error ?? '翻译失败');
  return { text: resp.translation, engine: resp.engine };
}

/** 截图翻译（需软件主体运行） */
export async function apiCaptureTranslate(req: CaptureTranslateRequest = {}): Promise<{ ocrText: string; translation: string }> {
  const resp = (await chrome.runtime.sendMessage({ type: 'capture-translate', ...req })) as
    | { ok: true; ocrText: string; translation: string }
    | { ok: false; error: string }
    | undefined;
  if (!resp?.ok) throw new Error(resp?.error ?? '截图翻译失败');
  return { ocrText: resp.ocrText, translation: resp.translation };
}

/** 框选翻译（需软件主体运行） */
export async function apiSelectCaptureTranslate(dst = 'zh'): Promise<{ ocrText: string; translation: string }> {
  const resp = (await chrome.runtime.sendMessage({ type: 'select-capture-translate', dst })) as
    | { ok: true; ocrText: string; translation: string }
    | { ok: false; error: string }
    | undefined;
  if (!resp?.ok) throw new Error(resp?.error ?? '框选翻译失败');
  return { ocrText: resp.ocrText, translation: resp.translation };
}

/** 通知 background 重新加载引擎配置（配置保存后调用，使 key 即时生效） */
export async function apiUpdateEngineConfig(): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'update-engine-config' }).catch(() => undefined);
}

/** 打开软件主体 AI 对话页（通过 background 转发，可扩展为 NM 指令） */
export async function apiOpenAiChat(): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'open-ai-chat' }).catch(() => undefined);
}

/**
 * 把浮窗内容推送到侧栏：写入 storage 草稿并打开侧栏（侧栏读取后自动填入）。
 */
export async function apiPushToSidebar(payload: { sourceText: string; translatedText: string }): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'push-to-sidebar', payload }).catch(() => undefined);
}

/** 通知 content script 执行全文翻译 */
export async function apiTranslatePage(tabId: number): Promise<void> {
  await chrome.tabs.sendMessage(tabId, { type: 'translate-page' }).catch(() => undefined);
}

/** 通知 content script 还原原文 */
export async function apiRestorePage(tabId: number): Promise<void> {
  await chrome.tabs.sendMessage(tabId, { type: 'restore-page' }).catch(() => undefined);
}