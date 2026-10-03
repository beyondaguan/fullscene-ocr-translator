/**
 * floating-panel 完整翻译浮窗测试：
 * - 显示浮窗：包含原文、译文、头部按钮与底部操作条
 * - 记录按钮回调触发 onSave
 * - ＋生词按钮回调触发 onAddVocabulary
 * - 送侧栏按钮回调触发 onSendToSidebar
 * - 朗读按钮调用 speechSynthesis.speak
 * - 复制按钮调用 clipboard
 * - 关闭按钮隐藏浮窗
 * - 同原文复用面板（不重建）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showFloatingPanel, hideFloatingPanel, isFloatingPanelVisible } from '../src/content/floating-panel';
import type { TranslationResult } from '../src/types/engine';

/** 取浮窗 Shadow DOM 内的按钮 */
function actButton(act: string): HTMLElement {
  const btn = document
    .querySelector('.fullscene-floating-panel')
    ?.shadowRoot?.querySelector<HTMLElement>(`[data-act="${act}"]`);
  if (!btn) throw new Error(`未找到按钮 data-act=${act}`);
  return btn;
}

describe('floating-panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    hideFloatingPanel();
  });

  afterEach(() => {
    hideFloatingPanel();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('显示浮窗：包含原文、译文、头部按钮与底部操作条', () => {
    const result: TranslationResult = { text: '你好', engine: 'mock' };
    const el = showFloatingPanel('Hello', result, {}, { x: 100, y: 100 });

    expect(el).not.toBeNull();
    expect(isFloatingPanelVisible()).toBe(true);

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    expect(shadow?.querySelector('.fs-src')?.textContent).toBe('Hello');
    expect(shadow?.querySelector('.fs-out')?.textContent).toBe('你好');
    // 头部：译 / 关闭
    expect(shadow?.querySelectorAll('.fs-btns button').length).toBe(2);
    // 底部：朗读 / 记录 / +生词 / 复制 / 送侧栏
    expect(shadow?.querySelectorAll('.fs-acts button').length).toBe(5);
  });

  it('点击「记录」按钮触发 onSave 回调', async () => {
    const result: TranslationResult = { text: '你好', engine: 'mock' };
    const onSave = vi.fn(async () => undefined);
    showFloatingPanel('Hello', result, { onSave, sourceLang: 'auto', targetLang: 'zh' }, { x: 100, y: 100 });

    actButton('save').click();

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        sourceText: 'Hello',
        translatedText: '你好',
        sourceLang: 'auto',
        targetLang: 'zh',
        engine: 'mock',
      });
    });
  });

  it('点击「＋生词」按钮触发 onAddVocabulary 回调', async () => {
    const result: TranslationResult = { text: '你好', engine: 'mock' };
    const onAddVocabulary = vi.fn(async () => undefined);
    showFloatingPanel(
      'Hello',
      result,
      { onAddVocabulary, sourceLang: 'en', targetLang: 'zh' },
      { x: 100, y: 100 },
    );

    actButton('vocab').click();

    await vi.waitFor(() => {
      expect(onAddVocabulary).toHaveBeenCalledWith({
        term: 'Hello',
        translation: '你好',
        sourceLang: 'en',
        targetLang: 'zh',
      });
    });
  });

  it('点击「送侧栏」按钮触发 onSendToSidebar 回调', async () => {
    const result: TranslationResult = { text: '你好', engine: 'mock' };
    const onSendToSidebar = vi.fn(async () => undefined);
    showFloatingPanel('Hello', result, { onSendToSidebar }, { x: 100, y: 100 });

    actButton('panel').click();

    await vi.waitFor(() => {
      expect(onSendToSidebar).toHaveBeenCalledWith({ sourceText: 'Hello', translatedText: '你好' });
    });
  });

  it('点击「朗读」按钮调用 speechSynthesis.speak', () => {
    const spoken: string[] = [];
    const speakMock = vi.fn((u: SpeechSynthesisUtterance) => spoken.push(u.text));
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: speakMock, cancel: vi.fn(), getVoices: () => [] },
      configurable: true,
      writable: true,
    });

    const result: TranslationResult = { text: '你好', engine: 'mock' };
    showFloatingPanel('Hello', result, { readLang: 'zh' }, { x: 100, y: 100 });

    actButton('speak').click();

    expect(spoken).toEqual(['你好']);
  });

  it('点击「复制」按钮调用 navigator.clipboard.writeText', async () => {
    const result: TranslationResult = { text: '你好', engine: 'mock' };
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    showFloatingPanel('Hello', result, {}, { x: 100, y: 100 });

    actButton('copy').click();

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('你好');
    });
  });

  it('点击「关闭」按钮隐藏浮窗', () => {
    const result: TranslationResult = { text: '你好', engine: 'mock' };
    showFloatingPanel('Hello', result, {}, { x: 100, y: 100 });
    expect(isFloatingPanelVisible()).toBe(true);

    actButton('close').click();

    expect(isFloatingPanelVisible()).toBe(false);
  });

  it('同原文复用面板，不重建', () => {
    const r1: TranslationResult = { text: '你好', engine: 'mock' };
    const el1 = showFloatingPanel('Hello', r1, {}, { x: 100, y: 100 });

    const r2: TranslationResult = { text: '你好呀', engine: 'mock' };
    const el2 = showFloatingPanel('Hello', r2, {}, { x: 200, y: 200 });

    // 复用同一 DOM 节点
    expect(el1).toBe(el2);
    // 译文更新
    expect(el2.shadowRoot?.querySelector('.fs-out')?.textContent).toBe('你好呀');
  });
});
