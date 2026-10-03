/**
 * chrome.storage 封装：类型安全的配置读写，带默认值与损坏回退。
 * sync 区用于跨设备同步偏好；local 区用于本地缓存。
 */
import type { AppConfig } from '../types/config';

/** 默认配置（空存储时返回） */
export const DEFAULT_CONFIG: AppConfig = {
  translation: {
    defaultEngine: 'microsoft',
    targetLang: 'zh',
    sourceLang: 'auto',
    // 仅登记随包实现的引擎：未实现引擎留在链里只会让失败提示变得误导
    fallbackChain: ['microsoft', 'mymemory', 'siliconflow', 'openai'],
    // SiliconFlow / OpenAI 兼容网关（默认官方端点 + 常用模型；key 留空则引擎不可用）
    siliconflow: {
      key: '',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-ai/DeepSeek-V3',
    },
    openai: {
      key: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    },
  },
  display: {
    mode: 'bilingual',
    theme: 'light',
    overlayOpacity: 0.9,
    fontSize: 14,
    realtime: false,
    highlight: false,
    selectionMode: 'button',
    panelMode: 'panel',
    pageMode: 'bilingual',
  },
  hotkeys: {
    bindings: {},
  },
  terminology: {
    enabled: false,
    customTerms: [],
  },
  privacy: {
    allowCloud: true,
    localOnly: false,
  },
};

/** 读取配置；storage 不可用或数据损坏时返回完整默认 */
export async function loadConfig(): Promise<AppConfig> {
  const storage = chromeStorage();
  if (!storage) return cloneConfig(DEFAULT_CONFIG);

  try {
    // chrome.storage.get(key) 返回 { key: value }，需取一层
    const result = (await storage.get('appConfig')) as Record<string, unknown> | undefined;
    const raw = result?.['appConfig'];
    if (!raw || typeof raw !== 'object') return cloneConfig(DEFAULT_CONFIG);
    return mergeConfig(DEFAULT_CONFIG, raw as Partial<AppConfig>);
  } catch {
    return cloneConfig(DEFAULT_CONFIG);
  }
}

/** 写入配置；storage 不可用时静默跳过 */
export async function saveConfig(config: AppConfig): Promise<void> {
  const storage = chromeStorage();
  if (!storage) return;
  try {
    await storage.set({ appConfig: config });
  } catch {
    // 存储失败不阻塞用户操作
  }
}

/** 读取任意键；不存在返回 undefined */
export async function loadRaw<T>(key: string): Promise<T | undefined> {
  const storage = chromeStorage();
  if (!storage) return undefined;
  try {
    const raw = await storage.get(key);
    return raw as T | undefined;
  } catch {
    return undefined;
  }
}

/** 写入任意键 */
export async function saveRaw(key: string, value: unknown): Promise<void> {
  const storage = chromeStorage();
  if (!storage) return;
  try {
    await storage.set({ [key]: value });
  } catch {
    // 忽略
  }
}

/** 深拷贝配置（避免共享引用） */
function cloneConfig(config: AppConfig): AppConfig {
  return JSON.parse(JSON.stringify(config)) as AppConfig;
}

/** 取 chrome.storage.sync；环境不可用时返回 undefined */
function chromeStorage(): chrome.storage.StorageArea | undefined {
  const api = (globalThis as unknown as { chrome?: { storage?: { sync?: chrome.storage.StorageArea } } }).chrome;
  return api?.storage?.sync;
}

/** 深度合并：raw 中的字段覆盖默认，缺失字段保留默认 */
function mergeConfig(base: AppConfig, raw: Partial<AppConfig>): AppConfig {
  const merged: AppConfig = cloneConfig(base);
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const baseValue = base[key as keyof AppConfig];
      const mergedValue = {
        ...(JSON.parse(JSON.stringify(baseValue)) as Record<string, unknown>),
        ...(value as unknown as Record<string, unknown>),
      };
      (merged as unknown as Record<string, unknown>)[key] = mergedValue;
    } else {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}