/**
 * 微软翻译引擎（免密钥）：复用 Bing Translator 的公开接口。
 *
 * 协议（与 bing-translate-api 同源）：
 * 1. GET https://cn.bing.com/translator（或 www.bing.com/translator）抓 HTML，
 *    正则提取 IG / IID / params_AbusePreventionHelper=[key, token, expiry]。
 * 2. POST https://{cn.}bing.com/ttranslatev3?isVertical=1&IG=...&IID=...
 *    表单：fromLang / to / text / token / key。
 * 3. 响应 JSON: [{ translations: [{ text, to }], detectedLanguage }]。
 *
 * 注意：MV3 background 有 host_permissions <all_urls>，fetch 不受 CORS 限制。
 * token 有有效期（约10分钟），带缓存复用；失败时自动重取一次。
 */

import type {
  BatchItem,
  HealthStatus,
  TranslationEngine,
  TranslateOptions,
  TranslationResult,
} from '../../types/engine';

/** 引擎名常量 */
export const MICROSOFT_ENGINE_NAME = 'microsoft';

/** token 抓取超时（毫秒） */
const TOKEN_TIMEOUT_MS = 8_000;

/** token 缓存有效期（毫秒）：Bing 的 params_AbusePreventionHelper 通常 10 分钟有效 */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** Bing 免费端点 legacy 模式文本上限（cn 子域 5000，国际 1000，保守取 1000 触发降级） */
const MAX_TEXT_LEN = 1000;

/** 支持的语言映射：扩展配置语言码 → Bing 语言码 */
const LANG_MAP: Record<string, string> = {
  auto: 'auto-detect',
  zh: 'zh-Hans',
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ru: 'ru',
  pt: 'pt',
  it: 'it',
  ar: 'ar',
  hi: 'hi',
};

/** 全局 token 缓存（跨实例共享，避免重复抓取） */
interface TokenCache {
  IG: string;
  IID: string;
  key: number;
  token: string;
  subdomain: 'cn' | 'www';
  fetchedAt: number;
}
let tokenCache: TokenCache | undefined;

/** 抓取 Bing 翻译页并解析 token */
async function fetchToken(): Promise<TokenCache> {
  const url = 'https://cn.bing.com/translator';
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    // 必须带超时：代理/墙内环境下 cn.bing.com 可能长时间无响应，
    // 无 timeout 的 fetch 会永久 pending → 前端按钮一直停在「翻译中…」，表现为"点了没反应"。
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`微软翻译 token 获取失败：HTTP ${res.status}`);
  const html = await res.text();

  const ig = html.match(/IG:"([^"]+)"/)?.[1];
  const iid = html.match(/data-iid="([^"]+)"/)?.[1];
  const helper = html.match(/params_AbusePreventionHelper\s?=\s?(\[[^\]]+\])/)?.[1];
  if (!ig || !iid || !helper) {
    throw new Error('微软翻译 token 解析失败（页面结构变化）');
  }
  let parsed: [number, string, number];
  try {
    parsed = JSON.parse(helper) as [number, string, number];
  } catch {
    throw new Error('微软翻译 token 解析失败（JSON 异常）');
  }
  const [key, token, _expiry] = parsed;
  if (!key || !token) throw new Error('微软翻译 token 解析失败（字段缺失）');

  const cache: TokenCache = { IG: ig, IID: iid, key, token, subdomain: 'cn', fetchedAt: Date.now() };
  tokenCache = cache;
  return cache;
}

/** 获取有效 token（带缓存） */
async function getToken(): Promise<TokenCache> {
  if (tokenCache && Date.now() - tokenCache.fetchedAt < TOKEN_TTL_MS) return tokenCache;
  return fetchToken();
}

/** 语言码转换：返回 Bing 语言码，不支持时返回 null */
function toBingLang(code: string): string | null {
  const key = code.trim().toLowerCase();
  return LANG_MAP[key] ?? null;
}

/** 解析 Bing 响应 */
function extractTranslation(payload: unknown): string | undefined {
  if (!Array.isArray(payload) || payload.length === 0) return undefined;
  const first = payload[0] as Record<string, unknown> | undefined;
  const translations = first?.translations;
  if (!Array.isArray(translations) || translations.length === 0) return undefined;
  const t = translations[0] as Record<string, unknown> | undefined;
  return typeof t?.text === 'string' ? t.text : undefined;
}

export class MicrosoftBingEngine implements TranslationEngine {
  readonly name = MICROSOFT_ENGINE_NAME;
  readonly label = '微软翻译';

  supportsLanguagePair(src: string, dst: string): boolean {
    const s = toBingLang(src);
    const d = toBingLang(dst);
    if (!s || !d) return false;
    if (s === 'auto-detect') return true;
    return s !== d;
  }

  async available(): Promise<boolean> {
    // 免密钥，始终可用（真实可用性在 translate 时校验）
    return true;
  }

  async translate(text: string, opts: TranslateOptions): Promise<TranslationResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('待翻译文本为空');
    if (trimmed.length > MAX_TEXT_LEN) {
      throw new Error(`微软翻译文本过长（>${MAX_TEXT_LEN} 字符），已降级`);
    }

    const from = toBingLang(opts.sourceLang);
    const to = toBingLang(opts.targetLang);
    if (!from || !to) {
      throw new Error(`微软翻译不支持该语言对（${opts.sourceLang} → ${opts.targetLang}）`);
    }

    const started = Date.now();
    let cache = await getToken();
    let body: unknown;
    try {
      body = await doTranslate(cache, trimmed, from, to);
    } catch (firstError) {
      // token 可能过期：强制重取一次再试
      tokenCache = undefined;
      try {
        cache = await fetchToken();
        body = await doTranslate(cache, trimmed, from, to);
      } catch {
        throw firstError instanceof Error ? firstError : new Error(String(firstError));
      }
    }

    const result = extractTranslation(body);
    if (!result || result.trim().length === 0) {
      throw new Error('微软翻译返回空译文');
    }
    return { text: result.trim(), engine: this.name, latencyMs: Date.now() - started };
  }

  async translateBatch(items: BatchItem[], opts: TranslateOptions): Promise<TranslationResult[]> {
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
      await getToken();
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** 执行一次 ttranslatev3 请求 */
async function doTranslate(
  cache: TokenCache,
  text: string,
  from: string,
  to: string,
): Promise<unknown> {
  const url =
    `https://${cache.subdomain}.bing.com/ttranslatev3?isVertical=1` +
    `&IG=${encodeURIComponent(cache.IG)}` +
    `&IID=${encodeURIComponent(cache.IID)}`;
  const form = new URLSearchParams();
  form.set('fromLang', from);
  form.set('to', to);
  form.set('text', text);
  form.set('token', cache.token);
  form.set('key', String(cache.key));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `https://${cache.subdomain}.bing.com/translator`,
    },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const errBody = (await res.json()) as { errorMessage?: string; statusCode?: number };
      detail = errBody.errorMessage ?? `HTTP ${res.status}`;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    throw new Error(`微软翻译请求失败：${detail}`);
  }
  return (await res.json()) as unknown;
}