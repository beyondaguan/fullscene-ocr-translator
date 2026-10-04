/**
 * Native Messaging 桥接（主程序内前端 ↔ Rust 命令层）。
 *
 * 运行环境判断：
 * - 在主程序（Tauri/WebView2）内：`window.__TAURI__` 存在，走 `invoke`；
 * - 在浏览器扩展 / 独立浏览器内：无 Tauri，返回明确「未在主程序中」错误。
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
  /** 最近一次实际服务翻译的引擎 id（降级链可能与配置首项不同） */
  engine: string;
  /** 该引擎在配置降级链中的位置（1-based，0 = 不在链中/未发生翻译） */
  engine_position: number;
  /** 配置降级链总长度 */
  engine_chain_len: number;
  /** 本次翻译前有几个引擎尝试失败 */
  engines_tried: number;
}

/** 生词本条目（与 Rust `WordEntry` 对齐，由 `list_words` 命令返回）。 */
export interface WordEntry {
  id: number;
  term: string;
  translation: string;
  context?: string | null;
  context_translation?: string | null;
  engine: string;
  src_lang?: string;
  dst_lang?: string;
  source_app?: string | null;
  created_at: string;
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
  /** 本地图片 OCR：前端把图片读成 base64 传进来，Rust 解码→OCR→翻译→回传原文+译文 */
  translateImageBytes: (base64: string, src?: string, dst?: string) => Promise<ShotResult>;
  /** AI 对话：传入完整对话历史，由可用对话引擎（SiliconFlow / OpenAI）生成回复 */
  chat: (messages: { role: string; content: string }[]) => Promise<string>;
  getHistory: (limit: number) => Promise<unknown[]>;
  /** 拉取最近一次管线结果：事件丢失时的权威兜底来源 */
  getResult: () => Promise<PipelineSnapshot>;
  clearHistory: () => Promise<void>;
  /** 生词本：列出词条（query 为搜索关键词，可空） */
  listWords: (limit: number, query?: string) => Promise<WordEntry[]>;
  /** 生词本：收藏当前译文（返回新条目 id） */
  addWord: (word: {
    term: string;
    translation: string;
    context?: string | null;
    context_translation?: string | null;
    engine?: string;
    src_lang?: string;
    dst_lang?: string;
    source_app?: string | null;
  }) => Promise<number>;
  /** 生词本：取消收藏（删除条目） */
  deleteWord: (id: number) => Promise<void>;
  /** 生词本：查询某词是否已收藏（收藏按钮初始态） */
  isWordSaved: (term: string) => Promise<boolean>;
}

interface TauriInvoke {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!hasTauri()) {
    return Promise.reject(new Error('未在主程序中运行（无 Tauri 桥）'));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tauri = (window as any).__TAURI__;
  const fn: TauriInvoke | undefined = tauri?.core?.invoke ?? tauri?.invoke;
  if (!fn) {
    return Promise.reject(new Error('Tauri invoke 不可用'));
  }
  return fn(cmd, args);
}

/** 创建桥接 API（默认在主程序内使用）。 */
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
    translateImageBytes: (base64, src, dst) =>
      invoke('translate_image_bytes', {
        base64,
        src: src ?? null,
        dst: dst ?? null,
      }) as Promise<ShotResult>,
    chat: (messages) => invoke('chat', { messages }) as Promise<string>,
    getHistory: (limit) => invoke('get_history', { limit }) as Promise<unknown[]>,
    getResult: () => invoke('get_result') as Promise<PipelineSnapshot>,
    clearHistory: () => invoke('clear_history').then(() => undefined),
    listWords: (limit, query) =>
      invoke('list_words', { limit, query: query ?? null }) as Promise<WordEntry[]>,
    addWord: (word) =>
      invoke('add_word', { word: word ?? null }) as Promise<number>,
    deleteWord: (id) => invoke('delete_word', { id }) as Promise<void>,
    isWordSaved: (term) =>
      invoke('is_word_saved', { term }) as Promise<boolean>,
  };
}