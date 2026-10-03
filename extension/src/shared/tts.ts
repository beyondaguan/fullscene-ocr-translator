/**
 * 语音合成（TTS）：封装浏览器 SpeechSynthesis API。
 * 提供 speak/cancel/pause/resume 与语言映射；在不支持的环境（如 Service Worker）
 * 显式抛错而非静默失效。另含 createReadAloudButton 便于在译文处挂「朗读」按钮。
 */

/** 朗读选项 */
export interface SpeakOptions {
  /** UI 语言代码（zh/en/ja/ko...），自动映射为 BCP-47 */
  lang?: string;
  rate?: number;
  pitch?: number;
  /** 指定语音名（可选） */
  voice?: string;
}

/** 环境是否支持语音合成 */
export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined';
}

/** 把 UI 语言代码映射为 BCP-47 语音 lang */
export function toVoiceLang(lang: string): string {
  const map: Record<string, string> = {
    zh: 'zh-CN',
    'zh-CN': 'zh-CN',
    en: 'en-US',
    'en-US': 'en-US',
    ja: 'ja-JP',
    ko: 'ko-KR',
    fr: 'fr-FR',
    de: 'de-DE',
    es: 'es-ES',
    ru: 'ru-RU',
  };
  return map[lang] ?? lang;
}

/** 获取可用语音列表 */
export function getVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSupported()) return [];
  return window.speechSynthesis.getVoices();
}

/** 朗读文本（打断上一条） */
export function speak(text: string, options: SpeakOptions = {}): void {
  if (!isSpeechSupported()) {
    throw new Error('当前环境不支持语音合成（SpeechSynthesis 不可用）');
  }
  if (!text.trim()) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = toVoiceLang(options.lang ?? 'zh');
  if (options.rate !== undefined) utterance.rate = options.rate;
  if (options.pitch !== undefined) utterance.pitch = options.pitch;
  if (options.voice) {
    const voice = getVoices().find((v) => v.name === options.voice || v.lang === options.voice);
    if (voice) utterance.voice = voice;
  }
  window.speechSynthesis.speak(utterance);
}

/** 停止朗读 */
export function cancel(): void {
  if (isSpeechSupported()) window.speechSynthesis.cancel();
}

/** 暂停 */
export function pause(): void {
  if (isSpeechSupported()) window.speechSynthesis.pause();
}

/** 继续 */
export function resume(): void {
  if (isSpeechSupported()) window.speechSynthesis.resume();
}

/** 创建「朗读」按钮（挂载到译文节点） */
export function createReadAloudButton(text: string, lang = 'zh'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fullscene-tts-btn';
  btn.textContent = '🔊';
  btn.title = '朗读';
  btn.setAttribute('aria-label', '朗读译文');
  btn.style.cssText =
    'margin-left:6px;padding:1px 6px;font:12px/1.4 system-ui,sans-serif;border:0.5px solid rgba(255,255,255,.6);' +
    'background:rgba(255,255,255,.16);color:inherit;border-radius:6px;cursor:pointer;vertical-align:middle;';
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    speak(text, { lang });
  });
  return btn;
}