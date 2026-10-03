/**
 * Native Messaging 桥接（软件主体内前端 ↔ Rust 命令层）。
 *
 * 运行环境判断：
 * - 在软件主体（Tauri/WebView2）内：`window.__TAURI__` 存在，走 `invoke`；
 * - 在浏览器扩展 / 独立浏览器内：无 Tauri，返回明确「未在软件主体中」错误。
 *
 * 前端路由（欢迎页 / 工作界面 / 设置页 / AI 对话）统一经此桥调用 Rust 命令。
 */

export interface ShotResult {
  /** OCR 识别出的原文（或用户粘贴的文本） */
  source: string;
  /** 译文 */
  translation: string;
}

/** 翻译引擎信息（设置抽屉渲染用） */
export interface EngineInfo {
  id: string;
  label: string;
  available: boolean;
}

/** 最近一次管线结果的权威快照（Rust 侧 `get_result` 命令返回）。 */
export interface PipelineSnapshot {
  source: string;
  translation: string;
  source_lang: string;
  updated_at_ms: number;
}

export interface NativeMsgApi {
  getConfig: () => Promise<unknown>;
  saveConfig: (config: unknown) => Promise<void>;
  /** 录入热键期间挂起全局热键（true = 挂起，false = 恢复），避免按键被全局热键抢走 */
  setHotkeysSuspended: (suspended: boolean) => Promise<void>;
  getStatus: () => Promise<{ config: unknown; ocr_ready: boolean; config_path: string }>;
  ping: () => Promise<string>;
  listEngines: () => Promise<EngineInfo[]>;
  testEngine: (id: string, text?: string) => Promise<string>;
  translateText: (text: string, src: string, dst: string) => Promise<string>;
  screenshotTranslate: (src?: string, dst?: string) => Promise<ShotResult>;
  getHistory: (limit: number) => Promise<unknown[]>;
  /** 拉取最近一次管线结果：事件丢失时的权威兜底来源 */
  getResult: () => Promise<PipelineSnapshot>;
  clearHistory: () => Promise<void>;
}

interface TauriInvoke {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!hasTauri()) {
    return Promise.reject(new Error('未在软件主体中运行（无 Tauri 桥）'));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tauri = (window as any).__TAURI__;
  const fn: TauriInvoke | undefined = tauri?.core?.invoke ?? tauri?.invoke;
  if (!fn) {
    return Promise.reject(new Error('Tauri invoke 不可用'));
  }
  return fn(cmd, args);
}

/** 创建桥接 API（默认在软件主体内使用）。 */
export function createNativeMsgApi(): NativeMsgApi {
  return {
    getConfig: () => invoke('get_config'),
    saveConfig: (config) => invoke('save_config', { config }).then(() => undefined),
    setHotkeysSuspended: (suspended) =>
      invoke('set_hotkeys_suspended', { suspended }).then(() => undefined),
    getStatus: () => invoke('get_status') as Promise<{ config: unknown; ocr_ready: boolean; config_path: string }>,
    ping: () => invoke('ping') as Promise<string>,
    listEngines: () => invoke('list_engines') as Promise<EngineInfo[]>,
    testEngine: (id, text) =>
      invoke('test_engine', { id, text: text ?? null }) as Promise<string>,
    translateText: (text, src, dst) => invoke('translate_text', { text, src, dst }) as Promise<string>,
    screenshotTranslate: (src, dst) =>
      invoke('screenshot_translate', { src: src ?? null, dst: dst ?? null }) as Promise<ShotResult>,
    getHistory: (limit) => invoke('get_history', { limit }) as Promise<unknown[]>,
    getResult: () => invoke('get_result') as Promise<PipelineSnapshot>,
    clearHistory: () => invoke('clear_history').then(() => undefined),
  };
}