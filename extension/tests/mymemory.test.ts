/**
 * MyMemory 引擎单元测试：语言对支持、翻译调用、错误处理。
 * fetch 由 vi.stubGlobal 注入 mock。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { MyMemoryEngine, chunkText } from '../src/background/engines/mymemory';

function mockFetchResponse(payload: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MyMemoryEngine', () => {
  it('supportsLanguagePair 支持 auto 源', () => {
    const engine = new MyMemoryEngine();
    expect(engine.supportsLanguagePair('auto', 'zh')).toBe(true);
    expect(engine.supportsLanguagePair('en', 'zh')).toBe(true);
    expect(engine.supportsLanguagePair('en', 'en')).toBe(false);
    expect(engine.supportsLanguagePair('xx', 'zh')).toBe(false);
  });

  it('translate 返回译文', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponse({
        responseData: { translatedText: '你好世界' },
        responseStatus: 200,
      }),
    );
    const engine = new MyMemoryEngine();
    const result = await engine.translate('Hello world', { sourceLang: 'en', targetLang: 'zh' });
    expect(result.text).toBe('你好世界');
    expect(result.engine).toBe('mymemory');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('HTTP 非 200 抛错', async () => {
    vi.stubGlobal('fetch', mockFetchResponse({}, false, 500));
    const engine = new MyMemoryEngine();
    await expect(engine.translate('hi', { sourceLang: 'en', targetLang: 'zh' })).rejects.toThrow('HTTP 500');
  });

  it('quotaFinished 抛额度错误', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponse({ responseData: undefined, responseStatus: 200, quotaFinished: true }),
    );
    const engine = new MyMemoryEngine();
    await expect(engine.translate('hi', { sourceLang: 'en', targetLang: 'zh' })).rejects.toThrow('今日免费额度已用尽');
  });

  it('空文本抛错', async () => {
    const engine = new MyMemoryEngine();
    await expect(engine.translate('  ', { sourceLang: 'en', targetLang: 'zh' })).rejects.toThrow('待翻译文本为空');
  });
});

describe('chunkText', () => {
  it('短文本不切分', () => {
    expect(chunkText('hello', 100)).toEqual(['hello']);
  });

  it('长文本按边界切分', () => {
    const text = 'word '.repeat(100).trim();
    const chunks = chunkText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 50)).toBe(true);
    expect(chunks.join('').replace(/\s+/g, ' ').trim()).toBe(text);
  });
});