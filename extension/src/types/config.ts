/**
 * AppConfig 配置接口与子类型。OCR 由软件主体（Rust host）承担，扩展端不再维护 OcrConfig。
 */

/** 翻译配置 */
export interface TranslationConfig {
  defaultEngine: string;
  targetLang: string;
  sourceLang: string;
  /** 降级链：主引擎失败后依次尝试 */
  fallbackChain: string[];
  /** SiliconFlow（OpenAI 兼容）配置 */
  siliconflow?: {
    key: string;
    baseUrl: string;
    model: string;
  };
  /** OpenAI / 任意 OpenAI 兼容网关配置 */
  openai?: {
    key: string;
    baseUrl: string;
    model: string;
  };
}

/** 显示配置 */
export interface DisplayConfig {
  /** 渲染模式 */
  mode: 'bilingual' | 'translation-only' | 'tooltip' | 'inline';
  /** 主题：light / dark */
  theme: 'light' | 'dark';
  /** 背景透明度 0-1 */
  overlayOpacity: number;
  /** 字体大小（px） */
  fontSize: number;
  /** 实时翻译：悬停任意文本即译（无需手动选中） */
  realtime: boolean;
  /** 高亮已翻译的原文选区 */
  highlight: boolean;
  /** 划词翻译触发方式：button=选中后出现浮动按钮，点击翻译；auto=选中即自动翻译；off=关闭划词 */
  selectionMode: 'button' | 'auto' | 'off';
  /** 划词结果交互：panel=完整翻译浮窗（常驻、可拖动、记录/复制）；light=轻量结果渲染（按 mode 渲染） */
  panelMode: 'panel' | 'light';
  /**
   * 全文翻译模式（翻译本页时生效）：
   * - bilingual：双语对照（保留原文，译文追加在原文下方）
   * - translation-only：仅译文（隐藏原文，只显示译文）
   */
  pageMode: 'bilingual' | 'translation-only';
}

/** 隐私配置 */
export interface PrivacyConfig {
  /** 是否允许云端翻译 */
  allowCloud: boolean;
  /** 仅本地（完全离线） */
  localOnly: boolean;
}

/** 术语库配置 */
export interface TerminologyConfig {
  enabled: boolean;
  /** 启用的内置术语库标识；缺省全部启用。当前内置：'medical'（医学）、'general'（通用） */
  enabledTermBases?: string[];
  /** 用户自定义术语 */
  customTerms: Array<{ term: string; translation: string }>;
}

/** 快捷键配置（完整结构见 types/hotkey.ts） */
export interface HotkeyConfig {
  bindings: Record<string, unknown>;
}

/** 顶层配置 */
export interface AppConfig {
  translation: TranslationConfig;
  display: DisplayConfig;
  hotkeys: HotkeyConfig;
  terminology: TerminologyConfig;
  privacy: PrivacyConfig;
}