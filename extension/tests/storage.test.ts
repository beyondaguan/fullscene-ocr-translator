/**
 * storage 单元测试：默认值、损坏回退、深度合并。
 * 使用 fake-indexeddb 不需要 —— chrome.storage 由 jsdom 注入 mock。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../src/shared/storage';

/** 简易 chrome.storage mock */
function installChromeStorageMock() {
  const store = new Map<string, unknown>();
  const mock = {
    storage: {
      sync: {
        async get(key: string | Record<string, unknown>) {
          if (typeof key === 'string') {
            return store.has(key) ? { [key]: store.get(key) } : {};
          }
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(key)) out[k] = store.has(k) ? store.get(k) : v;
          return out;
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        async remove(key: string) {
          store.delete(key);
        },
      },
    },
  };
  (globalThis as unknown as { chrome?: unknown }).chrome = mock;
}

describe('storage', () => {
  beforeEach(() => {
    installChromeStorageMock();
  });
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    vi.restoreAllMocks();
  });

  it('空存储返回默认配置', async () => {
    const cfg = await loadConfig();
    expect(cfg.translation.defaultEngine).toBe('microsoft');
    expect(cfg.translation.fallbackChain).toEqual(['microsoft', 'mymemory', 'siliconflow', 'openai']);
    expect(cfg.translation.siliconflow).toEqual(DEFAULT_CONFIG.translation.siliconflow);
    expect(cfg.translation.openai).toEqual(DEFAULT_CONFIG.translation.openai);
    expect(cfg.display.theme).toBe('light');
  });

  it('保存后能读回', async () => {
    const cfg = await loadConfig();
    cfg.translation.targetLang = 'en';
    cfg.display.theme = 'dark';
    await saveConfig(cfg);
    const loaded = await loadConfig();
    expect(loaded.translation.targetLang).toBe('en');
    expect(loaded.display.theme).toBe('dark');
  });

  it('损坏数据回退默认', async () => {
    const chrome = (globalThis as unknown as { chrome?: { storage?: { sync?: { set: (items: Record<string, unknown>) => Promise<void> } } } }).chrome;
    await chrome?.storage?.sync?.set({ appConfig: 'not-an-object' });
    const cfg = await loadConfig();
    expect(cfg.translation.defaultEngine).toBe(DEFAULT_CONFIG.translation.defaultEngine);
  });

  it('深度合并保留缺失子字段', async () => {
    const chrome = (globalThis as unknown as { chrome?: { storage?: { sync?: { set: (items: Record<string, unknown>) => Promise<void> } } } }).chrome;
    // 只覆盖 translation.targetLang，其余应保留默认
    await chrome?.storage?.sync?.set({ appConfig: { translation: { targetLang: 'ja' } } });
    const cfg = await loadConfig();
    expect(cfg.translation.targetLang).toBe('ja');
    expect(cfg.translation.defaultEngine).toBe(DEFAULT_CONFIG.translation.defaultEngine);
    expect(cfg.display.theme).toBe(DEFAULT_CONFIG.display.theme);
  });
});