/**
 * 引擎装配入口：在此登记所有随包发布的翻译引擎实现，background 启动时调用一次。
 *
 * 背景：engine-router 的 routeRules 里列了 ollama/lmstudio，
 * 但在本文件补齐实现之前它们全都"注册为空"，selectEngine 只会抛「没有可用的翻译引擎」。
 * 这里是唯一的注册点，新增引擎改这一个文件即可。
 */
import { registerEngine } from '../engine-router';
import { MYMEMORY_ENGINE_NAME, MyMemoryEngine } from './mymemory';
import { MICROSOFT_ENGINE_NAME, MicrosoftBingEngine } from './microsoft';
import {
  SILICONFLOW_ENGINE_NAME,
  OPENAI_ENGINE_NAME,
  OpenAiCompatEngine,
} from './openai-compat';
import type { AppConfig } from '../../types/config';

let registered = false;

/** 已登记引擎名（供 popup/sidebar 展示与自检） */
export const ACTIVE_ENGINE_NAMES: readonly string[] = [
  MICROSOFT_ENGINE_NAME,
  MYMEMORY_ENGINE_NAME,
  SILICONFLOW_ENGINE_NAME,
  OPENAI_ENGINE_NAME,
];

/** SiliconFlow / OpenAI 引擎实例引用（配置加载后同步 key） */
let siliconflowEngine: OpenAiCompatEngine | undefined;
let openaiEngine: OpenAiCompatEngine | undefined;

/**
 * 注册全部可用引擎（幂等）。
 * 抛错不扩散：单个引擎装配失败不应让整个 background 起不来，
 * 该引擎只会在被 selectEngine 选中时失败并降级到 fallbackChain。
 */
export function registerDefaultEngines(): void {
  if (registered) return;
  registered = true;

  // 免密钥微软翻译（Bing 公开接口），作为默认主引擎优先
  registerEngine(new MicrosoftBingEngine());
  registerEngine(new MyMemoryEngine());

  siliconflowEngine = new OpenAiCompatEngine({
    name: SILICONFLOW_ENGINE_NAME,
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
  });
  openaiEngine = new OpenAiCompatEngine({
    name: OPENAI_ENGINE_NAME,
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  });
  registerEngine(siliconflowEngine);
  registerEngine(openaiEngine);
}

/** 配置加载后调用：把保存的 key/base_url/model 同步进引擎实例 */
export function syncEngineConfig(config: AppConfig): void {
  const sf = config.translation.siliconflow;
  if (sf && siliconflowEngine) {
    siliconflowEngine.setApiKey(sf.key);
  }
  const oa = config.translation.openai;
  if (oa && openaiEngine) {
    openaiEngine.setApiKey(oa.key);
  }
}

/** 供测试复位注册状态 */
export function resetEngineRegistry(): void {
  registered = false;
  siliconflowEngine = undefined;
  openaiEngine = undefined;
}