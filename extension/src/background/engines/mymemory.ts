/**
 * MyMemory 翻译引擎实现（零密钥、可用即联网）。
 *
 * 线上验证（2026-09-25）：
 *   GET https://api.mymemory.translated.net/get?q=Hello,%20world&langpair=en|zh-CN
 *   -> {"responseData":{"translatedText":"你好世界","match":0.99},"responseStatus":200,...}
 *   GET ...&langpair=Autodetect|zh-CN -> 同上，并多返回 "detectedLanguage":"en"
 *   GET ...&langpair=Autodetect|ja （源=日）-> 403 "PLEASE SELECT TWO DISTINCT LANGUAGES"
 *
 * 匿名调用限制：单条 q 建议 ≤ 500 字符；按 IP 计每日额度。因此超长文本按块发送再拼接。
 */
import type { BatchItem, HealthStatus, TranslationEngine, TranslateOptions, TranslationResult } from '../../types/engine';

/** 引擎名（与 engine-router 的 routeRules / fallbackChain 中的 'mymemory' 对应） */
export const MYMEMORY_ENGINE_NAME = 'mymemory';

/** MyMemory 开放接口 */
const ENDPOINT = 'https://api.mymemory.translated.net/get';

/** 单次请求正文上限（匿名额度保护） */
const MAX_CHUNK_CHARS = 450;

/** available() 正结果缓存时长（ms） */
const AVAILABLE_OK_TTL = 60_000;

/** available() 负结果缓存时长（ms），避免限流时疯狂重试 */
const AVAILABLE_FAIL_TTL = 10_000;

/** 内部语言码 -> MyMemory 语言码 */
const LANG_MAP: Readonly<Record<string, string>> = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  cn: 'zh-CN',
  zhtw: 'zh-TW',
  zht: 'zh-TW',
  tw: 'zh-TW',
  en: 'en-US',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ru: 'ru',
};

/** 是否为"自动检测源语言"标记（本人写的 auto / autodetect / 空串都算） */
function isAutoLang(code: string): boolean {
  const normalized = code.trim().toLowerCase();
  return normalized === 'auto' || normalized === 'autodetect' || normalized === '';
}

/** MyMemory 拒绝翻译时返回的业务错误特征 */
const ERROR_MARKERS: readonly string[] = [
  'INVALID LANGUAGE PAIR',
  'PLEASE SELECT TWO DISTINCT LANGUAGES',
  'YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY',
];

/** 接口原始响应 */
interface MyMemoryResponse {
  responseData?: { translatedText?: string; detectedLanguage?: string };
  responseStatus?: number | string;
  responseDetails?: string;
  quotaFinished?: boolean | null;
}

/** 缓存条目：availability 探测结果 */
interface AvailabilityCache {
  ok: boolean;
  at: number;
}

export class MyMemoryEngine implements TranslationEngine {
  readonly name = MYMEMORY_ENGINE_NAME;

  private availability: AvailabilityCache | undefined;

  /**
   * 语言代码 -> MyMemory 代码；无法映射时返回 undefined。
   * 只认 LANG_MAP 内的语言（即 options 下拉里会出现的那些），
   * 不把任意两字母码原样透传，否则 'qq' 这类码会骗过 supportsLanguagePair 再在接口层炸掉。
   * 'zh-TW' / 'en-US' 这类 RFC3066 取主标签后同样可映射。
   */
  private toMyMemoryCode(code: string): string | undefined {
    const normalized = code.trim().toLowerCase();
    if (LANG_MAP[normalized]) return LANG_MAP[normalized];
    return LANG_MAP[normalized.split('-')[0] ?? ''];
  }

  /** MyMemory 的 langpair 串：源为 auto 时用 Autodetect */
  private toLangPair(sourceLang: string, targetLang: string): string | undefined {
    if (isAutoLang(sourceLang)) return `Autodetect|${this.toMyMemoryCode(targetLang) ?? targetLang}`;
    const src = this.toMyMemoryCode(sourceLang);
    const dst = this.toMyMemoryCode(targetLang);
    if (!src || !dst) return undefined;
    return `${src}|${dst}`;
  }

  supportsLanguagePair(src: string, dst: string): boolean {
    // 注意：不能用 normalizeLang 判 auto —— 它会截成 'au'，导致自动检测分支永远失效
    if (isAutoLang(src)) return !isAutoLang(dst) && this.toMyMemoryCode(dst) !== undefined;
    if (isAutoLang(dst)) return this.toMyMemoryCode(src) !== undefined;
    if (src.trim().toLowerCase() === dst.trim().toLowerCase()) return false;
    return this.toMyMemoryCode(src) !== undefined && this.toMyMemoryCode(dst) !== undefined;
  }

  /** 引擎可用性：带 TTL 缓存的轻量探测，避免每次翻译都多跑一次网络往返 */
  async available(): Promise<boolean> {
    const now = Date.now();
    if (this.availability) {
      const ttl = this.availability.ok ? AVAILABLE_OK_TTL : AVAILABLE_FAIL_TTL;
      if (now - this.availability.at < ttl) return this.availability.ok;
    }

    let ok = false;
    try {
      const response = await this.call('ok', 'en', 'zh-CN');
      ok = response.translatedText.length > 0;
    } catch {
      ok = false;
    }
    this.availability = { ok, at: Date.now() };
    return ok;
  }

  async translate(text: string, opts: TranslateOptions): Promise<TranslationResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('待翻译文本为空');

    const langPair = this.toLangPair(opts.sourceLang, opts.targetLang);
    if (!langPair) throw new Error(`MyMemory 不支持的语言组合（${opts.sourceLang} → ${opts.targetLang}）`);

    const started = Date.now();
    const chunks = chunkText(trimmed, MAX_CHUNK_CHARS);
    const translated: string[] = [];
    for (const chunk of chunks) translated.push((await this.call(chunk, opts.sourceLang, opts.targetLang, langPair)).translatedText);
    const joined = translated.join(' ').trim();

    if (!joined) throw new Error('MyMemory 返回空译文');
    return { text: joined, engine: this.name, latencyMs: Date.now() - started };
  }

  async translateBatch(items: BatchItem[], opts: TranslateOptions): Promise<TranslationResult[]> {
    // 顺序发送，避免匿名额度被并发打爆
    const results: TranslationResult[] = [];
    for (const item of items) {
      results.push(await this.translate(item.text, opts));
    }
    return results.sort((a, b) => {
      const ai = items.find((item) => item.text === a.text)?.index ?? 0;
      const bi = items.find((item) => item.text === b.text)?.index ?? 0;
      return ai - bi;
    });
  }

  async healthCheck(): Promise<HealthStatus> {
    const started = Date.now();
    try {
      const ok = await this.available();
      return { ok, latencyMs: Date.now() - started, detail: ok ? undefined : 'MyMemory 不可用' };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 调用一次接口并校验返回；grp 为探测用的固定缩短文本 */
  private async call(
    text: string,
    sourceLang: string,
    targetLang: string,
    langPair?: string,
  ): Promise<{ translatedText: string; detectedLanguage?: string }> {
    const pair = langPair ?? this.toLangPair(sourceLang, targetLang);
    if (!pair) throw new Error(`MyMemory 不支持的语言组合（${sourceLang} → ${targetLang}）`);

    const url = new URL(ENDPOINT);
    url.searchParams.set('q', text);
    url.searchParams.set('langpair', pair);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`MyMemory HTTP ${response.status}`);

    const payload = (await response.json()) as MyMemoryResponse;
    const status = Number(payload.responseStatus);
    const details = payload.responseDetails ?? '';

    if (payload.quotaFinished) throw new Error('MyMemory 今日免费额度已用尽');
    if (!payload.responseData?.translatedText) throw new Error(details || 'MyMemory 未返回译文');
    if (details && ERROR_MARKERS.some((marker) => details.includes(marker))) {
      throw new Error(`MyMemory 拒绝翻译：${details}`);
    }
    if (Number.isFinite(status) && status !== 200) throw new Error(`MyMemory 返回 ${status}：${details}`);

    return { translatedText: payload.responseData.translatedText, detectedLanguage: payload.responseData.detectedLanguage };
  }
}

/**
 * 按长度切分文本，优先在换行/空格处断开，减少跨句翻译导致的语义损伤。
 */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];

  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const slice = rest.slice(0, max);
    let cut = -1;
    const newline = slice.lastIndexOf('\n');
    if (newline > max * 0.5) cut = newline + 1;
    else {
      const space = slice.lastIndexOf(' ');
      if (space > max * 0.5) cut = space + 1;
    }
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) parts.push(rest);
  return parts.filter((part) => part.length > 0);
}