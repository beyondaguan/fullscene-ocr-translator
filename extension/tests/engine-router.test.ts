/**
 * engine-router 单元测试：注册、路由、降级链。
 * 不依赖真实网络：注入 mock 引擎。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  registerEngine,
  getEngine,
  listEngines,
  translateWithFallback,
  clearEngines,
  withTimeout,
} from '../src/background/engine-router';
import type { TranslationEngine, TranslationResult, TranslateOptions } from '../src/types/engine';

function makeEngine(name: string, opts?: { fail?: boolean; available?: boolean }): TranslationEngine {
  const fail = opts?.fail ?? false;
  const available = opts?.available ?? true;
  return {
    name,
    async available() {
      return available;
    },
    supportsLanguagePair(src: string, dst: string) {
      return src !== dst;
    },
    async translate(text: string, _opts: TranslateOptions): Promise<TranslationResult> {
      if (fail) throw new Error(`${name} 故障`);
      return { text: `[${name}]${text}`, engine: name };
    },
    async translateBatch(items: Array<{ text: string; index: number }>, opts: TranslateOptions) {
      const out: TranslationResult[] = [];
      for (const item of items) out.push(await this.translate(item.text, opts));
      return out;
    },
    async healthCheck() {
      return { ok: available, latencyMs: 1 };
    },
  };
}

beforeEach(() => {
  clearEngines();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('engine-router', () => {
  it('registerEngine / getEngine / listEngines', () => {
    registerEngine(makeEngine('a'));
    registerEngine(makeEngine('b'));
    expect(getEngine('a')?.name).toBe('a');
    expect(listEngines().map((e) => e.name).sort()).toEqual(['a', 'b']);
  });

  it('translateWithFallback 主引擎成功', async () => {
    registerEngine(makeEngine('primary'));
    const result = await translateWithFallback('hello', { sourceLang: 'en', targetLang: 'zh' }, []);
    expect(result.text).toBe('[primary]hello');
    expect(result.engine).toBe('primary');
  });

  it('主引擎失败 → fallback 链接管', async () => {
    registerEngine(makeEngine('primary', { fail: true }));
    registerEngine(makeEngine('backup'));
    const result = await translateWithFallback('hello', { sourceLang: 'en', targetLang: 'zh' }, ['backup']);
    expect(result.text).toBe('[backup]hello');
    expect(result.engine).toBe('backup');
  });

  it('全部失败抛出明确错误', async () => {
    registerEngine(makeEngine('primary', { fail: true }));
    registerEngine(makeEngine('backup', { fail: true }));
    await expect(
      translateWithFallback('hello', { sourceLang: 'en', targetLang: 'zh' }, ['backup']),
    ).rejects.toThrow('翻译失败');
  });
});

/**
 * 超时保护回归：
 * 真机曾出现「点了「译」→ 按钮停在「翻译中…」→ 永远没有结果也没有报错」，
 * 根因之一就是 Bing token 抓取的 fetch 没带 signal，网络挂起时 Promise 永久 pending。
 * 这里锁定"任何一步都必须有硬超时"这个不变量。
 */
describe('withTimeout', () => {
  it('永不 resolve 的 Promise 必须超时拒绝', async () => {
    await expect(withTimeout(new Promise(() => undefined), 50, '测试')).rejects.toThrow(/超时/);
  });

  it('正常结果不受影响', async () => {
    await expect(withTimeout(Promise.resolve(42), 50, '测试')).resolves.toBe(42);
  });

  it('正常 reject 原样透传', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50, '测试')).rejects.toThrow('boom');
  });
});