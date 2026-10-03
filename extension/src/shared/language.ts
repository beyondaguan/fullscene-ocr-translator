/**
 * 语言工具：语言代码归一化、语言对校验、常用语言列表。
 */

/** ISO 639-1 语言代码（小写） */
export type LangCode = string;

/** 支持的显示语言列表 */
export const SUPPORTED_LANGS: ReadonlyArray<{ code: LangCode; name: string }> = [
  { code: 'zh', name: '中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'ru', name: 'Русский' },
];

/** 归一化语言代码：去空白、转小写、取前两位 */
export function normalizeLang(code: string): LangCode {
  return code.trim().toLowerCase().slice(0, 2);
}

/** 语言对是否相同（归一化后比较） */
export function sameLangPair(a: { sourceLang: string; targetLang: string }, b: { sourceLang: string; targetLang: string }): boolean {
  return normalizeLang(a.sourceLang) === normalizeLang(b.sourceLang) && normalizeLang(a.targetLang) === normalizeLang(b.targetLang);
}

/** 语言代码是否在支持列表中 */
export function isSupportedLang(code: string): boolean {
  const normalized = normalizeLang(code);
  return SUPPORTED_LANGS.some((lang) => lang.code === normalized);
}

/** 语言对是否支持（双向任一在列表中即可） */
export function isSupportedPair(sourceLang: string, targetLang: string): boolean {
  return isSupportedLang(sourceLang) && isSupportedLang(targetLang);
}

/** 解析 Accept-Language 头部，返回优先级排序的语言代码列表（同一语言仅保留 q 最高的项） */
export function parseAcceptLanguage(header: string): LangCode[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [code, q] = part.trim().split(';q=');
      return { code: normalizeLang(code), q: q ? parseFloat(q) : 1 };
    })
    .sort((a, b) => b.q - a.q)
    .reduce<LangCode[]>((acc, item) => {
      // 去重：zh-CN 与 zh 归一化后相同，保留 q 更高的首个
      if (!acc.includes(item.code)) acc.push(item.code);
      return acc;
    }, []);
}