/**
 * hover-translator 划词翻译器测试：
 * - button 模式：选中文本后出现浮动「译」按钮，点击按钮才触发翻译
 * - auto 模式：选中文本后自动触发翻译
 * - off 模式：选中文本后不触发翻译、不显示按钮
 * - 空选区不触发
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHoverTranslator } from '../src/content/hover-translator';
import type { TranslationResult } from '../src/types/engine';

function makeSelection(text: string): void {
  // jsdom 的 window.getSelection 返回空对象，这里直接 mock
  Object.defineProperty(window, 'getSelection', {
    value: () => ({ toString: () => text, rangeCount: 0 }),
    configurable: true,
    writable: true,
  });
}

describe('createHoverTranslator', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    // 清理可能残留的按钮
    document.querySelectorAll('.fullscene-selection-button').forEach((el) => el.remove());
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('button 模式：选中文本后显示浮动「译」按钮，点击后才翻译', async () => {
    const translate = vi.fn(async (): Promise<TranslationResult> => ({ text: '你好', engine: 'mock' }));
    const renderResult = vi.fn();
    const deps = {
      translate,
      showTooltip: vi.fn(),
      hideTooltip: vi.fn(),
      selectionMode: 'button' as const,
      renderSelectionResult: renderResult,
    };
    const h = createHoverTranslator(deps, 0);

    makeSelection('Hello world');
    // 模拟 mouseup（右键/左键选中后松开）
    h.onSelect(new MouseEvent('mouseup', { clientX: 100, clientY: 50 }));

    // 按钮应出现
    const btn = document.querySelector('.fullscene-selection-button');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('译');

    // 未点击按钮前不应翻译
    expect(translate).not.toHaveBeenCalled();

    // 点击按钮触发翻译
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(translate).toHaveBeenCalledWith('Hello world');
      expect(renderResult).toHaveBeenCalledWith(
        expect.objectContaining({ text: '你好' }),
        'Hello world',
        expect.any(Object),
      );
    });

    h.destroy();
  });

  it('auto 模式：选中文本后自动翻译（不显示按钮）', async () => {
    const translate = vi.fn(async (): Promise<TranslationResult> => ({ text: '你好', engine: 'mock' }));
    const showTooltip = vi.fn();
    const deps = {
      translate,
      showTooltip,
      hideTooltip: vi.fn(),
      selectionMode: 'auto' as const,
    };
    const h = createHoverTranslator(deps, 0);

    makeSelection('Hello world');
    h.onSelect(new MouseEvent('mouseup', { clientX: 100, clientY: 50 }));

    // 不应出现按钮
    expect(document.querySelector('.fullscene-selection-button')).toBeNull();

    await vi.waitFor(() => {
      expect(translate).toHaveBeenCalledWith('Hello world');
      expect(showTooltip).toHaveBeenCalledWith(expect.objectContaining({ text: '你好' }), {
        x: 100,
        y: 50,
      });
    });

    h.destroy();
  });

  it('off 模式：选中文本后不翻译、不显示按钮', async () => {
    const translate = vi.fn(async (): Promise<TranslationResult> => ({ text: '你好', engine: 'mock' }));
    const deps = {
      translate,
      showTooltip: vi.fn(),
      hideTooltip: vi.fn(),
      selectionMode: 'off' as const,
    };
    const h = createHoverTranslator(deps, 0);

    makeSelection('Hello world');
    h.onSelect(new MouseEvent('mouseup', { clientX: 100, clientY: 50 }));

    expect(document.querySelector('.fullscene-selection-button')).toBeNull();
    expect(translate).not.toHaveBeenCalled();

    h.destroy();
  });

  it('空选区不触发翻译也不显示按钮', async () => {
    const translate = vi.fn(async (): Promise<TranslationResult> => ({ text: '', engine: 'mock' }));
    const deps = {
      translate,
      showTooltip: vi.fn(),
      hideTooltip: vi.fn(),
      selectionMode: 'button' as const,
    };
    const h = createHoverTranslator(deps, 0);

    makeSelection('');
    h.onSelect(new MouseEvent('mouseup', { clientX: 100, clientY: 50 }));

    expect(document.querySelector('.fullscene-selection-button')).toBeNull();
    expect(translate).not.toHaveBeenCalled();

    h.destroy();
  });
});