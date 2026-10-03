/**
 * 微软翻译引擎单元测试：语言映射、token 抓取、翻译调用、错误处理。
 * fetch 分两步 mock：GET translator 页面 → POST ttranslatev3。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MicrosoftBingEngine, MICROSOFT_ENGINE_NAME } from '../src/background/engines/microsoft';

/** 构造一个含 IG/IID/params 的模拟 Bing 翻译页 HTML */
function mockTranslatorHtml(): string {
  return `<!DOCTYPE html><html><head><script>
    IG:"MOCK_IG_1234567890";
    var params_AbusePreventionHelper = [1710000000000, "MOCK_TOKEN_abcdef", 600000];
  </script></head><body>
    <div data-iid="translator.5028.1">Bing Translator</div>
  </body></html>`;
}

/** mock fetch：第一次调用返回翻译页，第二次调用返回翻译 JSON */
function mockFetchSequence(translationText = '你好世界') {
  const html = mockTranslatorHtml();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    // 第一次：GET translator 页面
    if (String(url).includes('/translator')) {
      return {
        ok: true,
        status: 200,
        text: async () => html,
      } as Response;
    }
    // 第二次：POST ttranslatev3
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          detectedLanguage: { language: 'en', score: 1 },
          translations: [{ text: translationText, to: 'zh-Hans' }],
        },
      ],
    } as Response;
  });
  return { fn, calls };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MicrosoftBingEngine', () => {
  it('supportsLanguagePair 正确映射中英文', () => {
    const engine = new MicrosoftBingEngine();
    expect(engine.supportsLanguagePair('auto', 'zh')).toBe(true);
    expect(engine.supportsLanguagePair('en', 'zh')).toBe(true);
    expect(engine.supportsLanguagePair('zh', 'en')).toBe(true);
    expect(engine.supportsLanguagePair('en', 'en')).toBe(false);
    expect(engine.supportsLanguagePair('xx', 'zh')).toBe(false);
  });

  it('translate 抓 token 并返回译文', async () => {
    const { fn, calls } = mockFetchSequence('你好世界');
    vi.stubGlobal('fetch', fn);
    const engine = new MicrosoftBingEngine();
    const result = await engine.translate('Hello world', { sourceLang: 'en', targetLang: 'zh' });
    expect(result.text).toBe('你好世界');
    expect(result.engine).toBe(MICROSOFT_ENGINE_NAME);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // 确认调用了两次 fetch：translator 页面 + ttranslatev3
    expect(calls.length).toBe(2);
    expect(calls[0].url).toContain('/translator');
    expect(calls[1].url).toContain('ttranslatev3');
  });

  it('连续两次翻译都成功（token 缓存复用）', async () => {
    const { fn } = mockFetchSequence('你好世界');
    vi.stubGlobal('fetch', fn);
    const engine = new MicrosoftBingEngine();
    const r1 = await engine.translate('Hello', { sourceLang: 'en', targetLang: 'zh' });
    const r2 = await engine.translate('World', { sourceLang: 'en', targetLang: 'zh' });
    expect(r1.text).toBe('你好世界');
    expect(r2.text).toBe('你好世界');
    expect(r1.engine).toBe(MICROSOFT_ENGINE_NAME);
    expect(r2.engine).toBe(MICROSOFT_ENGINE_NAME);
  });

  it('ttranslatev3 请求体包含 token/key/fromLang/to', async () => {
    const { fn, calls } = mockFetchSequence();
    vi.stubGlobal('fetch', fn);
    const engine = new MicrosoftBingEngine();
    await engine.translate('Hello', { sourceLang: 'en', targetLang: 'zh' });
    const post = calls.find((c) => c.url.includes('ttranslatev3'));
    expect(post).toBeDefined();
    const body = post!.init?.body?.toString() ?? '';
    expect(body).toContain('fromLang=en');
    expect(body).toContain('to=zh-Hans');
    expect(body).toContain('token=MOCK_TOKEN_abcdef');
    expect(body).toContain('key=1710000000000');
  });

  it('空文本抛错', async () => {
    const engine = new MicrosoftBingEngine();
    await expect(engine.translate('  ', { sourceLang: 'en', targetLang: 'zh' })).rejects.toThrow('待翻译文本为空');
  });

  it('文本过长抛错', async () => {
    const engine = new MicrosoftBingEngine();
    const long = 'a'.repeat(1001);
    await expect(engine.translate(long, { sourceLang: 'en', targetLang: 'zh' })).rejects.toThrow('文本过长');
  });

  it('不支持语言对抛错', async () => {
    const engine = new MicrosoftBingEngine();
    await expect(engine.translate('hi', { sourceLang: 'xx', targetLang: 'zh' })).rejects.toThrow('不支持该语言对');
  });
});