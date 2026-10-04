/**
 * 翻译引擎路由器主类：引擎注册/发现、可用性检测、智能路由、缓存与失败降级编排。
 */
import type { TranslationEngine, TranslateOptions, TranslationResult } from '../types/engine';
import type { PrivacyConfig, TerminologyConfig } from '../types/config';
import { cache, makeKey } from './cache';
import { buildGlossary, maskText, restoreText } from './terminology';

/** 路由规则：按场景配置引擎优先级 */
export interface RouteRule {
  engine: string;
  priority: number;
  /** 文本长度上限（字符数），超过则跳过 */
  maxLen?: number;
  /** 是否免费（免费引擎优先用于短文本） */
  free?: boolean;
}

/** 引擎注册表 */
const engines = new Map<string, TranslationEngine>();

/**
 * 路由规则表（骨架：仅登记已实现引擎）。
 * microsoft 免密钥在线（Bing 公开接口，免费、优先）；
 * mymemory 在线免费；ollama/lmstudio 为本地 LLM（由主程序/用户自行启动，占位）；
 * siliconflow/openai 为 OpenAI 兼容云端引擎（需用户配置 API Key，优先级最高）。
 */
const routeRules: RouteRule[] = [
  { engine: 'microsoft', priority: 0, maxLen: 1000, free: true },
  { engine: 'siliconflow', priority: 0, maxLen: 8000 },
  { engine: 'openai', priority: 0, maxLen: 8000 },
  { engine: 'mymemory', priority: 1, free: true },
  { engine: 'ollama', priority: 2, maxLen: 4000 },
  { engine: 'lmstudio', priority: 3, maxLen: 4000 },
];

/** 单个引擎尝试的超时（毫秒）：卡住的引擎必须让位给降级链上的下一个 */
const ENGINE_ATTEMPT_TIMEOUT_MS = 12_000;

/** 整条降级链的总超时（毫秒）：超过后必须抛错，前端才能给出可见提示而不是永远转圈 */
const TOTAL_TRANSLATE_TIMEOUT_MS = 20_000;

/**
 * 给 Promise 套硬超时。
 * 背景：无超时的网络请求在代理/断网环境下会永久 pending，
 * 前端只会看到按钮停在「翻译中…」，表现为"点了没反应"却毫无错误信息。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    guard,
  ]);
}

/** 注册引擎 */
export function registerEngine(engine: TranslationEngine): void {
  engines.set(engine.name, engine);
}

/** 获取已注册引擎 */
export function getEngine(name: string): TranslationEngine | undefined {
  return engines.get(name);
}

/** 全部已注册引擎 */
export function listEngines(): TranslationEngine[] {
  return [...engines.values()];
}

/**
 * 按路由表 + 健康度选最优引擎。
 * 过滤：supportsLanguagePair && available；排序：priority 小者优先、free 优先。
 */
export async function selectEngine(
  src: string,
  dst: string,
  text: string,
  privacy?: PrivacyConfig,
): Promise<TranslationEngine> {
  // 已注册但不在路由表的引擎（如测试 mock 或动态注册）作为最低优先级兜底候选
  const ruleEngines = new Set(routeRules.map((rule) => rule.engine));
  const allRules: RouteRule[] = [
    ...routeRules,
    ...listEngines()
      .filter((engine) => !ruleEngines.has(engine.name))
      .map((engine) => ({ engine: engine.name, priority: Number.MAX_SAFE_INTEGER })),
  ];

  const candidates = allRules
    .filter((rule) => {
      const engine = engines.get(rule.engine);
      if (!engine) return false;
      if (!engine.supportsLanguagePair(src, dst)) return false;
      if (rule.maxLen !== undefined && text.length > rule.maxLen) return false;
      if (privacy?.localOnly && !isLocalEngine(rule.engine)) return false;
      if (privacy && !privacy.allowCloud && !isFreeOrLocalEngine(rule.engine)) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.free !== b.free) return a.free ? -1 : 1;
      return 0;
    });

  for (const rule of candidates) {
    const engine = engines.get(rule.engine);
    if (!engine) continue;
    // available() 也可能走网络探活（如 mymemory），同样必须限时
    const available = await withTimeout(engine.available(), ENGINE_ATTEMPT_TIMEOUT_MS, `引擎 ${rule.engine} 可用性检测`).catch(() => false);
    if (available) return engine;
  }

  throw new Error(`没有可用的翻译引擎（${src} → ${dst}）`);
}

/**
 * 带缓存 + 降级的翻译入口。
 * 1. 查缓存 → 命中直接返回（cached=true）
 * 2. select_engine 选主引擎 → 翻译
 * 3. 主引擎失败 → 按 fallbackChain 逐个重试
 * 4. 全失败 → 抛出明确错误
 */
export async function translateWithFallback(
  text: string,
  opts: TranslateOptions,
  fallbackChain: string[] = [],
  privacy?: PrivacyConfig,
  terminology?: TerminologyConfig,
): Promise<TranslationResult> {
  const key = makeKey(text, opts.sourceLang, opts.targetLang);
  const cached = await cache.get(key);
  if (cached) return { ...cached, cached: true };

  // 术语优先：译前 mask 占位符，译后 restore 规范译文
  const glossary = terminology ? buildGlossary(terminology, opts.sourceLang, opts.targetLang) : [];
  const { masked, tokens } = glossary.length ? maskText(text, glossary) : { masked: text, tokens: [] };

  const primary = await selectEngine(opts.sourceLang, opts.targetLang, masked, privacy);
  const chain = [primary.name, ...fallbackChain.filter((name) => name !== primary.name)];

  // 整条链的总时长也要封顶，避免"每个引擎各自 12 秒"累加成一次永远不落地的等待
  return withTimeout(runChain(chain, masked, opts, key, tokens), TOTAL_TRANSLATE_TIMEOUT_MS, '翻译');
}

/** 依次尝试降级链上的每个引擎（每个引擎单独限时） */
async function runChain(
  chain: string[],
  masked: string,
  opts: TranslateOptions,
  key: string,
  tokens: Array<{ token: string; target: string }>,
): Promise<TranslationResult> {
  let lastError: unknown;
  for (const engineName of chain) {
    const engine = engines.get(engineName);
    if (!engine) continue;
    try {
      const result = await withTimeout(
        engine.translate(masked, { ...opts, engine: engineName }),
        ENGINE_ATTEMPT_TIMEOUT_MS,
        `引擎 ${engineName}`,
      );
      const finalText = tokens.length ? restoreText(result.text, tokens) : result.text;
      const finalResult: TranslationResult = { ...result, text: finalText };
      await cache.set(key, finalResult);
      return finalResult;
    } catch (error) {
      lastError = error;
      // 继续尝试下一个引擎
    }
  }

  throw new Error(`翻译失败（已尝试 ${chain.join(' → ')}）：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** 批量翻译（逐条走降级链，保持顺序） */
export async function translateBatchWithFallback(
  items: Array<{ text: string; index: number }>,
  opts: TranslateOptions,
  fallbackChain: string[] = [],
  privacy?: PrivacyConfig,
): Promise<TranslationResult[]> {
  const results = await Promise.all(
    items.map((item) => translateWithFallback(item.text, opts, fallbackChain, privacy)),
  );
  return results.sort((a, b) => {
    const ai = items.find((item) => item.text === a.text)?.index ?? 0;
    const bi = items.find((item) => item.text === b.text)?.index ?? 0;
    return ai - bi;
  });
}

/** 判断是否为本地引擎（不需要网络） */
function isLocalEngine(name: string): boolean {
  return name === 'ollama' || name === 'lmstudio';
}

/** 判断是否为免费或本地引擎（隐私关闭云端时仍可用） */
function isFreeOrLocalEngine(name: string): boolean {
  return isLocalEngine(name) || name === 'mymemory';
}

/** 获取缓存层引用（供测试与外部使用） */
export function getCache() {
  return { get: cache.get, set: cache.set, prune: cache.prune, makeKey: cache.makeKey };
}

/** 清空注册表（测试用） */
export function clearEngines(): void {
  engines.clear();
}