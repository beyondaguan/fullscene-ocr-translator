/**
 * 配置热更新（chrome.storage.onChanged → 重建悬停翻译器）测试：
 * - destroyHoverTranslator 后重新 initHoverTranslator，事件监听不会叠加（重建安全）
 * - 重建后新配置生效（selectionMode 从 button 切到 auto，行为随之变化）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initHoverTranslator, destroyHoverTranslator } from '../src/content/hover-translator';
import type { TranslationResult } from '../src/types/engine';

function makeSelection(text: string): void {
  Object.defineProperty(window, 'getSelection', {
    value: () => ({ toString: () => text, rangeCount: 0 }),
    configurable: true,
    writable: true,
  });
}

function makeDeps(overrides: { selectionMode?: 'button' | 'auto' | 'off'; translate?: ReturnType<typeof vi.fn> } = {}) {
  const translate =
    overrides.translate ??
    vi.fn(async (): Promise<TranslationResult> => ({ text: '你好', engine: 'mock' }));
  return {
    translate,
    showTooltip: vi.fn(),
    hideTooltip: vi.fn(),
    selectionMode: (overrides.selectionMode ?? 'button') as 'button' | 'auto' | 'off',
    renderSelectionResult: vi.fn(),
  };
}

describe('config hot reload（重建悬停翻译器）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // 确保每次测试从干净状态开始
    destroyHoverTranslator();
  });

  afterEach(() => {
    destroyHoverTranslator();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('销毁后重新 init 不会导致事件监听叠加（同一 mouseup 只触发一次翻译）', async () => {
    const deps1 = makeDeps({ selectionMode: 'button' });
    initHoverTranslator(deps1, 0);

    // 第一次 init 后，模拟选中并点击「译」按钮
    makeSelection('Hello world');
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 50 }));
    const btn1 = document.querySelector('.fullscene-selection-button');
    expect(btn1).not.toBeNull();
    btn1?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(deps1.translate).toHaveBeenCalledTimes(1);
    });

    // 销毁并重建（模拟配置变更）
    destroyHoverTranslator();
    const deps2 = makeDeps({ selectionMode: 'button' });
    initHoverTranslator(deps2, 0);

    // 再次选中并点击按钮
    makeSelection('Hello again');
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 200, clientY: 80 }));
    const btn2 = document.querySelector('.fullscene-selection-button');
    expect(btn2).not.toBeNull();
    btn2?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(deps2.translate).toHaveBeenCalledTimes(1);
    });

    // 旧实例不应再收到事件
    expect(deps1.translate).toHaveBeenCalledTimes(1);
  });

  it('重建后新配置生效：从 button 切到 auto 后，选中不再出现按钮而是直接翻译', async () => {
    // 第一次：button 模式
    const deps1 = makeDeps({ selectionMode: 'button' });
    initHoverTranslator(deps1, 0);

    makeSelection('Hello world');
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 50 }));
    expect(document.querySelector('.fullscene-selection-button')).not.toBeNull();

    // 销毁重建为 auto 模式
    destroyHoverTranslator();
    const deps2 = makeDeps({ selectionMode: 'auto' });
    initHoverTranslator(deps2, 0);

    makeSelection('Hello auto');
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 50 }));

    // 不应出现按钮，且自动翻译
    expect(document.querySelector('.fullscene-selection-button')).toBeNull();
    await vi.waitFor(() => {
      expect(deps2.translate).toHaveBeenCalledWith('Hello auto');
    });
  });
});