/**
 * 翻译引擎抽象接口与引擎类型：所有引擎实现统一契约。
 */

/** 翻译选项 */
export interface TranslateOptions {
  sourceLang: string;
  targetLang: string;
  /** 指定引擎名；不传则由路由器选最优 */
  engine?: string;
}

/** 翻译结果 */
export interface TranslationResult {
  text: string;
  engine: string;
  cached?: boolean;
  latencyMs?: number;
}

/** 批量翻译项 */
export interface BatchItem {
  text: string;
  index: number;
}

/** 健康状态 */
export interface HealthStatus {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

/**
 * 引擎契约：所有云/本地引擎实现它。
 * name 唯一，注册到 engine-router 的注册表。
 */
export interface TranslationEngine {
  readonly name: string;
  /** 引擎是否可用（网络/密钥/本地服务可达） */
  available(): Promise<boolean>;
  /** 是否支持该语言对 */
  supportsLanguagePair(src: string, dst: string): boolean;
  /** 单条翻译 */
  translate(text: string, opts: TranslateOptions): Promise<TranslationResult>;
  /** 批量翻译（同语言对） */
  translateBatch(items: BatchItem[], opts: TranslateOptions): Promise<TranslationResult[]>;
  /** 健康检查 */
  healthCheck(): Promise<HealthStatus>;
}