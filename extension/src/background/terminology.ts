/**
 * 术语库匹配引擎（M11）：翻译过程中的「术语优先」保真。
 *
 * 设计要点：
 * 1. 内置术语库（医学 + 通用）与用户自定义术语合并为方向敏感的词汇表（sourceLang → targetLang）。
 * 2. 译前把原文中的术语替换为私有区占位符（mask），避免翻译引擎把领域术语翻错。
 * 3. 译后把占位符还原为术语库中的规范译文（restore），保证术语一致。
 *
 * 这是翻译管线的可选增强：translateWithFallback 在 terminology.enabled 时调用本模块。
 */
import type { TerminologyConfig } from '../types/config';

/** 单条术语（带方向） */
export interface TermEntry {
  source: string;
  target: string;
  sourceLang: string;
  targetLang: string;
  /** 所属内置库标识（'medical' | 'general'）；自定义项无此字段 */
  base?: string;
}

/** 内置术语库（医学优先，覆盖泌尿外科/通用高频词） */
export const BUILTIN_TERMS: TermEntry[] = [
  // —— 医学 medical（en → zh）——
  { source: 'benign prostatic hyperplasia', target: '良性前列腺增生', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'prostate cancer', target: '前列腺癌', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'urinary tract infection', target: '尿路感染', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'bladder cancer', target: '膀胱癌', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'kidney stone', target: '肾结石', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'ureteral calculi', target: '输尿管结石', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'erectile dysfunction', target: '勃起功能障碍', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'acute renal failure', target: '急性肾衰竭', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'chronic kidney disease', target: '慢性肾脏病', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'urinary incontinence', target: '尿失禁', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'hematuria', target: '血尿', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'dysuria', target: '排尿困难', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'cystoscopy', target: '膀胱镜检查', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'transurethral resection', target: '经尿道切除', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  { source: 'prostate specific antigen', target: '前列腺特异性抗原', sourceLang: 'en', targetLang: 'zh', base: 'medical' },
  // —— 通用 general（en → zh）——
  { source: 'artificial intelligence', target: '人工智能', sourceLang: 'en', targetLang: 'zh', base: 'general' },
  { source: 'machine learning', target: '机器学习', sourceLang: 'en', targetLang: 'zh', base: 'general' },
  { source: 'operating system', target: '操作系统', sourceLang: 'en', targetLang: 'zh', base: 'general' },
  { source: 'source code', target: '源代码', sourceLang: 'en', targetLang: 'zh', base: 'general' },
  // —— 反向（zh → en）——
  { source: '良性前列腺增生', target: 'benign prostatic hyperplasia', sourceLang: 'zh', targetLang: 'en', base: 'medical' },
  { source: '前列腺癌', target: 'prostate cancer', sourceLang: 'zh', targetLang: 'en', base: 'medical' },
  { source: '尿路感染', target: 'urinary tract infection', sourceLang: 'zh', targetLang: 'en', base: 'medical' },
  { source: '膀胱癌', target: 'bladder cancer', sourceLang: 'zh', targetLang: 'en', base: 'medical' },
  { source: '肾结石', target: 'kidney stone', sourceLang: 'zh', targetLang: 'en', base: 'medical' },
  { source: '人工智能', target: 'artificial intelligence', sourceLang: 'zh', targetLang: 'en', base: 'general' },
  { source: '机器学习', target: 'machine learning', sourceLang: 'zh', targetLang: 'en', base: 'general' },
];

/** 占位符基址（Unicode 私有区，翻译引擎通常不会改写） */
const TOKEN_BASE = 0xe000;
/** 占位符上限（超出则回退为多字符编码，见 maskText） */
const TOKEN_LIMIT = 0xefff - TOKEN_BASE;

export interface MaskResult {
  /** 替换了占位符的文本（发给翻译引擎） */
  masked: string;
  /** 占位符 → 规范译文的映射 */
  tokens: Array<{ token: string; target: string }>;
}

function normalizeLang(lang: string): string {
  return (lang || '').toLowerCase().split('-')[0];
}

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9\u00C0-\u024F]/.test(ch);
}

/**
 * 合并内置 + 自定义术语，返回匹配当前翻译方向的词汇表。
 * @param srcLang 源语言（如 'en' / 'zh-CN'）
 * @param dstLang 目标语言
 */
export function buildGlossary(
  config: TerminologyConfig | undefined,
  srcLang: string,
  dstLang: string,
): TermEntry[] {
  if (!config?.enabled) return [];
  const src = normalizeLang(srcLang);
  const dst = normalizeLang(dstLang);
  const enabledBases = config.enabledTermBases;

  const entries: TermEntry[] = [];

  for (const e of BUILTIN_TERMS) {
    if (normalizeLang(e.sourceLang) !== src || normalizeLang(e.targetLang) !== dst) continue;
    if (enabledBases && enabledBases.length > 0 && e.base && !enabledBases.includes(e.base)) continue;
    entries.push(e);
  }

  for (const c of config.customTerms ?? []) {
    const term = c.term?.trim();
    const translation = c.translation?.trim();
    if (term && translation) {
      entries.push({ source: term, target: translation, sourceLang: srcLang, targetLang: dstLang });
    }
  }

  return entries;
}

/** 把原文中的术语替换为占位符（长词优先 + 词边界保护，避免 cat 误伤 category） */
export function maskText(text: string, entries: TermEntry[]): MaskResult {
  const tokens: Array<{ token: string; target: string }> = [];
  let masked = text;

  const sorted = [...entries]
    .filter((e) => e.source.length > 0)
    .sort((a, b) => b.source.length - a.source.length);

  for (const e of sorted) {
    const term = e.source;
    let i = 0;
    while (i <= masked.length - term.length) {
      if (masked.startsWith(term, i)) {
        const before = masked[i - 1];
        const after = masked[i + term.length];
        const boundaryOk = !isWordChar(before) && !isWordChar(after);
        if (boundaryOk) {
          const tokenCode = TOKEN_BASE + tokens.length;
          const token =
            tokens.length <= TOKEN_LIMIT
              ? String.fromCharCode(tokenCode)
              : `\uE000${tokenCode.toString(16)}\uE001`;
          masked = masked.slice(0, i) + token + masked.slice(i + term.length);
          tokens.push({ token, target: e.target });
          i += token.length;
          continue;
        }
      }
      i += 1;
    }
  }

  return { masked, tokens };
}

/** 把译后文本中的占位符还原为规范译文 */
export function restoreText(translated: string, tokens: Array<{ token: string; target: string }>): string {
  let out = translated;
  for (const { token, target } of tokens) {
    out = out.split(token).join(target);
  }
  return out;
}

/**
 * 一次性完成 mask + restore 的便捷封装（供测试与简单调用）。
 * 真实管线请在 engine-router 内分别调用 maskText/restoreText 以贴合缓存键。
 */
export function applyTerminology(
  text: string,
  config: TerminologyConfig | undefined,
  srcLang: string,
  dstLang: string,
): { masked: string; tokens: Array<{ token: string; target: string }> } {
  const entries = buildGlossary(config, srcLang, dstLang);
  return maskText(text, entries);
}