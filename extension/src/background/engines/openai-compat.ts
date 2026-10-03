/**
 * OpenAI 兼容聊天模型翻译引擎：SiliconFlow 与 OpenAI 共用同一协议。
 *
 * 与 crates/core/src/translate/engines/openai_compat.rs 的行为保持一致：
 * - 端点：{base_url}/chat/completions
 * - 请求体：system 提示「只输出译文」+ user 提示「将 X 文本翻译为 Y」，temperature 0.3，stream false
 * - 响应解析：choices[0].message.content
 * - available()：仅检查 key 是否已配置（不发起网络请求）
 *
 * 设计上只用一个类，通过配置区分两个品牌（SiliconFlow / OpenAI）：
 * - SiliconFlow 默认 base_url=https://api.siliconflow.cn/v1，默认模型 deepseek-ai/DeepSeek-V3
 * - OpenAI 默认 base_url=https://api.openai.com/v1，默认模型 gpt-4o-mini
 */

import type { BatchItem, HealthStatus, TranslationEngine, TranslateOptions, TranslationResult } from '../../types/engine';

/** 引擎名常量 */
export const SILICONFLOW_ENGINE_NAME = 'siliconflow';
export const OPENAI_ENGINE_NAME = 'openai';

/** OpenAI 兼容引擎的品牌/默认配置 */
export interface OpenAiCompatConfig {
  /** 引擎名（siliconflow / openai） */
  name: string;
  /** 引擎显示名 */
  label: string;
  /** API Key */
  apiKey?: string;
  /** OpenAI 兼容 base_url（默认官方） */
  baseUrl: string;
  /** 模型名 */
  model: string;
}

/** 翻译用的系统提示词（与 Rust 侧保持一致） */
const SYSTEM_PROMPT = '你是专业翻译引擎。只输出译文，不要解释、不要标点以外的附加内容。';

/** 构建 user 提示词：与 Rust 侧语义一致 */
function buildUserPrompt(text: string, src: string, dst: string): string {
  const srcHint = src.trim().toLowerCase() === 'auto' || src.trim() === '' ? '自动识别源语言' : src;
  return `将以下${srcHint}文本翻译为${dst}：\n${text}`;
}

/** 从 OpenAI 兼容响应中提取译文 */
function extractTranslation(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const obj = payload as Record<string, unknown>;
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === 'string' ? content : undefined;
}

export class OpenAiCompatEngine implements TranslationEngine {
  readonly name: string;
  readonly label: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private apiKey: string;

  constructor(config: OpenAiCompatConfig) {
    this.name = config.name;
    this.label = config.label;
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.apiKey = config.apiKey ?? '';
  }

  /** 更新 API Key（运行时配置变更后调用） */
  setApiKey(key: string): void {
    this.apiKey = key;
  }

  supportsLanguagePair(src: string, dst: string): boolean {
    // 大模型翻译不限制语言对；仅阻止同语言（避免无意义调用）
    const s = src.trim().toLowerCase();
    const d = dst.trim().toLowerCase();
    return s !== d;
  }

  async available(): Promise<boolean> {
    return this.apiKey.trim().length > 0;
  }

  async translate(text: string, opts: TranslateOptions): Promise<TranslationResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('待翻译文本为空');
    if (!this.apiKey.trim()) throw new Error(`${this.label} 未配置 API Key`);

    const started = Date.now();
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(trimmed, opts.sourceLang, opts.targetLang) },
      ],
      temperature: 0.3,
      stream: false,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new Error(`${this.label} 请求失败：${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as { error?: { message?: string } };
        detail = errBody.error?.message ?? '';
      } catch {
        // 忽略响应体解析失败
      }
      throw new Error(`${this.label} HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }

    const payload = (await response.json()) as unknown;
    const content = extractTranslation(payload);
    if (!content || content.trim().length === 0) {
      throw new Error(`${this.label} 返回空译文`);
    }

    return { text: content.trim(), engine: this.name, latencyMs: Date.now() - started };
  }

  async translateBatch(items: BatchItem[], opts: TranslateOptions): Promise<TranslationResult[]> {
    // 与 mymemory 一致：顺序发送，避免并发触发限流
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
    const ok = this.apiKey.trim().length > 0;
    return {
      ok,
      latencyMs: Date.now() - started,
      detail: ok ? undefined : `${this.label} 未配置 API Key`,
    };
  }
}