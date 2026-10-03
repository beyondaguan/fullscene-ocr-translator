/**
 * 「译」按钮点击链路回归测试（真实事件序列）。
 *
 * 历史 bug（真实浏览器表现为「点了按钮：原文抖一下、按钮跳一下、然后没反应」）：
 * 1. mouseup 早于 click。抑制标记若只挂在 click，拦不住 mouseup 阶段的 onSelect ——
 *    onSelect 会删旧按钮 + 建新按钮 + 再高亮一次，导致 click 永不触发、翻译从未被调用。
 * 2. document 上的监听靠 btn 的 'remove' 事件清理（DOM 无此事件）→ 句柄泄漏 →
 *    旧闭包在捕获阶段误删当前按钮，click 同样丢失。
 * 3. highlightRange 在选区形成时立刻 <mark> 包裹 → 改 DOM（原文视觉抖动）+ 销毁选区。
 *
 * 现行设计（不依赖任何时序启发式）：
 * - 翻译在 **mousedown** 阶段就启动，不等 mouseup/click；
 * - btn 的 mouseup 直接 stopPropagation，onSelect 根本收不到；
 * - 高亮推迟到翻译成功后执行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initHoverTranslator, destroyHoverTranslator } from '../src/content/hover-translator';
import type { TranslationResult } from '../src/types/engine';

function makeSelection(text: string, withRange = false): void {
  const range = document.createRange();
  Object.defineProperty(window, 'getSelection', {
    value: () => ({
      toString: () => text,
      rangeCount: withRange ? 1 : 0,
      getRangeAt: () => range,
    }),
    configurable: true,
    writable: true,
  });
}

/** 划词结束：在页面上松开鼠标（冒泡到 document 的 onSelect） */
function finishSelection(x = 100, y = 50): void {
  document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
}

/** 点击「译」按钮的真实序列：mousedown → mouseup → click */
function clickButton(btn: HTMLElement): void {
  btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function queryButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.fullscene-selection-button');
}

function makeDeps(translate: (text: string) => Promise<TranslationResult>) {
  return {
    translate,
    showTooltip: vi.fn(),
    hideTooltip: vi.fn(),
    selectionMode: 'button' as const,
    renderSelectionResult: vi.fn(),
    highlightSource: vi.fn(),
    onError: vi.fn(),
  };
}

describe('「译」按钮点击链路', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="page">Hello world</div>';
  });

  afterEach(() => {
    destroyHoverTranslator();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('按下即触发翻译（不依赖 mouseup / click）', async () => {
    const translate = vi.fn(async (): Promise<TranslationResult> => ({ text: '你好', engine: 'mock' }));
    initHoverTranslator(makeDeps(translate), 0);

    makeSelection('Hello world');
    finishSelection();
    const btn = queryButton() as HTMLElement;
    expect(btn).not.toBeNull();

    // 仅 mousedown 一个事件，翻译就必须已经启动
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(translate).toHaveBeenCalledWith('Hello world');
    expect(btn.textContent).toBe('翻译中…');
  });

  it('完整点击序列只翻译一次（mousedown/mouseup/click 幂等）', async () => {
    const translate = vi.fn(async (): Promise<TranslationResult> => ({ text: '你好', engine: 'mock' }));
    const deps = makeDeps(translate);
    initHoverTranslator(deps, 0);

    makeSelection('Hello world');
    finishSelection();
    clickButton(queryButton() as HTMLElement);

    await vi.waitFor(() => {
      expect(deps.renderSelectionResult).toHaveBeenCalledWith(
        expect.objectContaining({ text: '你好' }),
        'Hello world',
        expect.any(Object),
      );
    });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('mouseup 不被 document 的 onSelect 接收（按钮不重建、原文不重复高亮）', () => {
    const translate = vi.fn(async (): Promise<TranslationResult> => ({ text: '你好', engine: 'mock' }));
    initHoverTranslator(makeDeps(translate), 0);

    makeSelection('Hello world');
    finishSelection();
    const btn = queryButton();

    btn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    btn?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    // 按钮仍是同一个元素且仍在 DOM（若 onSelect 执行就会被"删旧建新"）
    expect(queryButton()).toBe(btn);
    expect(btn?.isConnected).toBe(true);
  });

  it('高亮推迟到翻译成功后：划词瞬间不改动 DOM', async () => {
    const translate = vi.fn(async (): Promise<TranslationResult> => ({ text: '你好', engine: 'mock' }));
    const deps = makeDeps(translate);
    initHoverTranslator(deps, 0);

    makeSelection('Hello world', true);
    finishSelection();
    // 划词刚结束：不应立刻高亮（否则 <mark> 包裹会让原文抖动并销毁选区）
    expect(deps.highlightSource).not.toHaveBeenCalled();

    clickButton(queryButton() as HTMLElement);
    await vi.waitFor(() => {
      expect(deps.highlightSource).toHaveBeenCalledTimes(1);
    });
  });

  it('第二次划词后点击按钮仍有效（document 监听器不泄漏）', async () => {
    const translate = vi.fn(async (): Promise<TranslationResult> => ({ text: '你好', engine: 'mock' }));
    initHoverTranslator(makeDeps(translate), 0);

    makeSelection('Hello world');
    finishSelection(100, 50);
    clickButton(queryButton() as HTMLElement);

    // 第二轮：若监听器泄漏，旧闭包会在 mousedown 捕获阶段误删当前按钮
    makeSelection('Second text');
    finishSelection(200, 120);
    const btn2 = queryButton() as HTMLElement;
    expect(btn2).not.toBeNull();

    clickButton(btn2);
    await vi.waitFor(() => {
      expect(translate).toHaveBeenCalledWith('Second text');
    });
  });

  it('翻译失败时按钮恢复「译」、给出可见错误、可重试', async () => {
    let attempt = 0;
    const translate = vi.fn(async (): Promise<TranslationResult> => {
      attempt += 1;
      if (attempt === 1) throw new Error('引擎不可用');
      return { text: '你好', engine: 'mock' };
    });
    const deps = makeDeps(translate);
    initHoverTranslator(deps, 0);

    makeSelection('Hello world');
    finishSelection();
    const btn = queryButton() as HTMLElement;
    clickButton(btn);

    await vi.waitFor(() => {
      expect(btn.textContent).toBe('译');
      expect(btn.isConnected).toBe(true);
      expect(deps.onError).toHaveBeenCalledWith('引擎不可用');
    });

    clickButton(btn);
    await vi.waitFor(() => {
      expect(translate).toHaveBeenCalledTimes(2);
    });
  });
});
