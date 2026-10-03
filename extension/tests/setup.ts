/**
 * vitest 全局 setup：注入最小 chrome mock（storage / runtime / tabs / commands / sidePanel）。
 * 使 storage / i18n / api 等模块可在 jsdom 下测试。
 */

/** 内存存储 */
const memStore = new Map<string, unknown>();

/** 最小 chrome mock */
const chromeMock = {
  storage: {
    local: {
      async get(key: string | Record<string, unknown>) {
        if (typeof key === 'string') {
          return memStore.has(key) ? { [key]: memStore.get(key) } : {};
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(key)) out[k] = memStore.has(k) ? memStore.get(k) : v;
        return out;
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) memStore.set(k, v);
      },
      async remove(key: string) {
        memStore.delete(key);
      },
    },
    sync: {
      async get(key: string | Record<string, unknown>) {
        if (typeof key === 'string') {
          return memStore.has(key) ? { [key]: memStore.get(key) } : {};
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(key)) out[k] = memStore.has(k) ? memStore.get(k) : v;
        return out;
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) memStore.set(k, v);
      },
      async remove(key: string) {
        memStore.delete(key);
      },
    },
  },
  runtime: {
    sendMessage: async () => ({ ok: true, translation: 'mock', engine: 'mymemory' }),
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    onConnect: { addListener: () => undefined },
  },
  tabs: {
    query: async () => [{ id: 1 }],
    sendMessage: async () => undefined,
  },
  commands: {
    onCommand: { addListener: () => undefined },
  },
  sidePanel: {
    open: async () => undefined,
  },
  windows: { WINDOW_ID_CURRENT: -1, getLastFocused: async () => ({ id: 1 }) },
};

(globalThis as unknown as { chrome?: unknown }).chrome = chromeMock;

/**
 * 最小 Web Speech API mock。
 * jsdom 未实现 speechSynthesis / SpeechSynthesisUtterance，
 * 缺少它时 shared/tts.ts 的 speak() 会抛错，朗读相关测试无法断言。
 */
class MockUtterance {
  text: string;
  lang = '';
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoice | null = null;
  constructor(text = '') {
    this.text = text;
  }
}

const speechMock = {
  speak: () => undefined,
  cancel: () => undefined,
  pause: () => undefined,
  resume: () => undefined,
  getVoices: () => [] as SpeechSynthesisVoice[],
};

(globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = MockUtterance;
Object.defineProperty(window, 'speechSynthesis', { value: speechMock, configurable: true, writable: true });