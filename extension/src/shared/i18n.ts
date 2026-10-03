/**
 * 国际化（i18n）：消息目录 + t() 查表 + 语言持久化。
 * React 页面直接调用 t()，不再使用 data-i18n DOM 扫描（那是旧 popup 的用法）。
 */

/** 支持的语言 */
export type Locale = 'zh-CN' | 'en';

type Dict = Record<string, string>;

const zhCN: Dict = {
  'app.title': '全场景OCR翻译',
  'action.translatePage': '翻译本页',
  'action.restore': '还原原文',
  'action.capture': '截图翻译',
  'action.selectCapture': '框选翻译',
  'action.openChat': '打开 AI 对话',
  'action.openSettings': '打开设置',
  'action.swap': '交换语言',
  'label.engine': '翻译引擎',
  'label.sourceLang': '源语言',
  'label.targetLang': '目标语言',
  'label.theme': '主题',
  'label.renderMode': '渲染模式',
  'placeholder.input': '输入文本...',
  'status.translating': '翻译中...',
  'status.error': '错误',
  'status.noText': '未识别到文字',
  'status.hostNotFound': '未检测到软件主体，请先安装并启动',
  'mode.bilingual': '双语对照',
  'mode.translationOnly': '仅译文',
  'mode.tooltip': 'Tooltip',
  'mode.inline': '原位覆盖',
  'theme.light': '浅色',
  'theme.dark': '深色',
  'lang.auto': '自动检测',
  'tts.readAloud': '朗读',
  'history.title': '最近翻译',
  'history.empty': '暂无历史',
};

const en: Dict = {
  'app.title': 'FullScene OCR Translator',
  'action.translatePage': 'Translate page',
  'action.restore': 'Restore original',
  'action.capture': 'Screenshot Translate',
  'action.selectCapture': 'Select & Translate',
  'action.openChat': 'Open AI Chat',
  'action.openSettings': 'Open settings',
  'action.swap': 'Swap languages',
  'label.engine': 'Engine',
  'label.sourceLang': 'Source',
  'label.targetLang': 'Target',
  'label.theme': 'Theme',
  'label.renderMode': 'Render mode',
  'placeholder.input': 'Type text...',
  'status.translating': 'Translating...',
  'status.error': 'Error',
  'status.noText': 'No text recognized',
  'status.hostNotFound': 'Software host not found. Install and launch it first.',
  'mode.bilingual': 'Bilingual',
  'mode.translationOnly': 'Translation only',
  'mode.tooltip': 'Tooltip',
  'mode.inline': 'Inline',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'lang.auto': 'Auto detect',
  'tts.readAloud': 'Read aloud',
  'history.title': 'Recent translations',
  'history.empty': 'No history yet',
};

const messages: Record<Locale, Dict> = { 'zh-CN': zhCN, en };

let current: Locale = 'zh-CN';

/** 判断是否为受支持的语言 */
export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

/** 读取当前语言 */
export function getLocale(): Locale {
  return current;
}

/** 设置当前语言（内存） */
export function setLocale(locale: Locale): void {
  current = locale;
}

/**
 * 取消息文案。
 * @param key 消息键
 * @param vars 插值变量 {name}
 * @param locale 指定语言，缺省用 current
 */
export function t(key: string, vars?: Record<string, string | number>, locale: Locale = current): string {
  const dict = messages[locale] ?? messages['zh-CN'];
  let text = dict[key] ?? messages['zh-CN'][key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
    }
  }
  return text;
}

/** 从 chrome.storage.local 读取持久化语言（默认跟随浏览器语言） */
export async function loadLocale(): Promise<Locale> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get('fullscene.locale');
      const value = stored['fullscene.locale'];
      if (isLocale(value)) {
        current = value;
        return current;
      }
    }
  } catch {
    // 非扩展环境（如纯测试）忽略
  }
  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('en')) {
    current = 'en';
  }
  return current;
}

/** 持久化语言选择 */
export async function saveLocale(locale: Locale): Promise<void> {
  current = locale;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ 'fullscene.locale': locale });
    }
  } catch {
    // 非扩展环境忽略
  }
}