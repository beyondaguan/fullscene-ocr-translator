/**
 * 悬停翻译器（划词翻译 + 实时翻译）：mousemove/mouseup 捕获、getSelection、防抖、Tooltip 浮动层。
 *
 * - `realtime`：悬停任意文本元素即译（无需手动选中），由 deps.realtime 控制；
 * - `selectionMode`：划词触发方式——
 *   - `button`：选中文本后出现浮动「翻译」按钮，点击按钮才翻译（沙拉查词式交互）；
 *   - `auto`：选中文本后自动翻译（防抖后直接显示结果）；
 *   - `off`：关闭划词翻译（仅保留实时悬停）。
 * - `highlightSource`：选中触发翻译时回调，传入选区 Range，用于高亮已译原文。
 */
import type { TranslationResult } from '../types/engine';
import { debounce } from '../shared/debounce';

/** 悬停翻译器依赖 */
export interface HoverTranslatorDeps {
  /** 翻译函数：接收文本，返回 Promise<TranslationResult> */
  translate: (text: string) => Promise<TranslationResult>;
  /** 显示 Tooltip */
  showTooltip: (result: TranslationResult, at: { x: number; y: number }) => void;
  /** 隐藏 Tooltip */
  hideTooltip: () => void;
  /** 实时翻译：悬停即译（无需选中） */
  realtime?: boolean;
  /** 划词触发方式：button=浮动按钮点击翻译；auto=选中即自动翻译；off=关闭。缺省 auto（向后兼容） */
  selectionMode?: 'button' | 'auto' | 'off';
  /** 渲染划词翻译结果（按钮点击/自动翻译后调用，按用户配置的展示方式渲染） */
  renderSelectionResult?: (result: TranslationResult, originalText: string, at?: { x: number; y: number }) => void;
  /** 选中译文时回调，传入选区 Range 用于高亮原文（在翻译**成功后**调用） */
  highlightSource?: (range: Range) => void;
  /** 翻译失败时的可见反馈；缺省只把按钮恢复为「译」，用户会看到"点了没反应" */
  onError?: (message: string) => void;
}

/** 最近指针位置 */
let lastPointer: { x: number; y: number } = { x: 0, y: 0 };
/** 当前选区文本（选中模式） */
let currentSelection = '';

/**
 * 创建悬停翻译器。
 * @param deps 依赖注入
 * @param debounceMs 防抖延迟，默认 250ms
 */
export function createHoverTranslator(deps: HoverTranslatorDeps, debounceMs: number = 250): {
  onMove: (e: MouseEvent) => void;
  onSelect: (e: MouseEvent) => void;
  destroy: () => void;
} {
  const selectionMode = deps.selectionMode ?? 'auto';
  /**
   * 抑制窗口标记：按住「译」按钮期间置位，click 处理里清零。
   * 必须在 mousedown 阶段置位——mouseup 早于 click 触发，
   * 只在 click 里置位拦不住 mouseup 阶段的 onSelect 重建。
   */
  const lastButtonClickAt = { current: 0 };

  /**
   * 最近一次有效选区的 Range 快照。
   * 高亮推迟到翻译成功后才执行——立刻 surroundContents 会改动 DOM（<mark> 包裹），
   * 既让原文视觉抖动，又会销毁用户刚划出的选区。
   */
  let lastRange: Range | null = null;

  /** 执行一次划词翻译（按钮 mousedown 即调用；auto 模式由防抖包装后调用） */
  const runTranslate = (text: string): void => {
    if (text === '') return;
    void deps
      .translate(text)
      .then((result) => {
        // 期间选区已变（用户重新划词）：丢弃过期结果，避免译文错位
        if (currentSelection !== text) return;
        // 翻译成功后才高亮原文（此时选区已完成使命，改 DOM 不再有副作用）
        if (deps.highlightSource && lastRange) deps.highlightSource(lastRange);
        // 翻译完成：销毁「译」按钮，再渲染结果
        hideSelectionButton();
        if (deps.renderSelectionResult) {
          deps.renderSelectionResult(result, text, lastPointer);
        } else {
          deps.showTooltip(result, lastPointer);
        }
      })
      .catch((error: unknown) => {
        // 翻译失败：恢复按钮为「译」并允许重试，同时给出可见提示
        if (selectionButton) {
          selectionButton.textContent = '译';
          selectionButton.style.opacity = '1';
          selectionButton.style.cursor = 'pointer';
          delete selectionButton.dataset.busy;
        }
        deps.onError?.(error instanceof Error ? error.message : String(error));
      });
  };

  /** auto 模式的持久防抖翻译（只创建一次，确保 timer 正确清除） */
  const debouncedTranslate = debounce(() => {
    runTranslate(currentSelection);
  }, debounceMs);

  /** 实时模式的持久防抖翻译 */
  let lastHovered = '';
  const debouncedHover = debounce(() => {
    const text = lastHovered;
    if (!text) return;
    void deps.translate(text).then((result) => {
      if (lastHovered === text) deps.showTooltip(result, lastPointer);
    });
  }, debounceMs);

  /** 记录指针位置；realtime 模式下顺便翻译悬停文本 */
  const onMove = (e: MouseEvent): void => {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!deps.realtime) return;

    const text = hoveredText(e.target);
    if (text && text !== lastHovered) {
      lastHovered = text;
      debouncedHover();
    }
  };

  /** mouseup 且有选区时，取 selection 文本并触发翻译 */
  const onSelect = (e: MouseEvent): void => {
    lastPointer = { x: e.clientX, y: e.clientY };

    // 在「译」按钮上松开鼠标：直接跳过。
    // mouseup 早于 click 触发，若不拦截，onSelect 会「先删旧按钮再建新按钮」，
    // 使正在被点击的按钮从 DOM 消失 → click 永不触发 → 翻译根本不会被调用。
    const upTarget = e.target as Node | null;
    if (upTarget && selectionButton && (upTarget === selectionButton || selectionButton.contains(upTarget))) {
      return;
    }

    // 兜底：按下按钮后 400ms 内的 mouseup 一律忽略（mousedown 阶段已置位标记，
    // 覆盖"按钮内按下、按钮外松开"等 target 不在按钮上的情况）。
    if (Date.now() - lastButtonClickAt.current < 400) return;

    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    currentSelection = text;

    if (text === '') {
      deps.hideTooltip();
      hideSelectionButton();
      return;
    }

    // 只保存 Range 快照，不在此刻高亮（高亮会改 DOM 并销毁选区，详见 runTranslate）
    lastRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;

    // 清除旧 tooltip 避免闪烁
    deps.hideTooltip();

    if (selectionMode === 'off') {
      hideSelectionButton();
      return;
    }

    if (selectionMode === 'button') {
      // 按钮模式：在选区末端显示浮动「翻译」按钮，按下即翻译。
      // 注意传 runTranslate（立即执行）而非 debouncedTranslate（带防抖）——
      // 用户已经按下按钮，再等一个防抖周期毫无意义，且会拖长"点了没反应"的窗口。
      showSelectionButton(e, lastButtonClickAt, runTranslate);
      return;
    }

    // auto 模式：选中即自动翻译
    hideSelectionButton();
    debouncedTranslate();
  };

  /** 清理 */
  const destroy = (): void => {
    deps.hideTooltip();
    hideSelectionButton();
    currentSelection = '';
    lastHovered = '';
  };

  return { onMove, onSelect, destroy };
}

/** 当前显示的浮动翻译按钮（全局唯一） */
let selectionButton: HTMLElement | null = null;
/**
 * 挂在 document 上的监听器引用（全局唯一）。
 * 之前靠 btn 的 'remove' 事件清理——DOM 标准里并没有 remove 事件，
 * 导致监听器只增不减；累积后旧闭包会把"当前按钮"误删，点击彻底失效。
 */
let docMouseDownHandler: ((ev: MouseEvent) => void) | null = null;
let docScrollHandler: (() => void) | null = null;

/** 在选区末端显示浮动「翻译」按钮 */
function showSelectionButton(
  e: MouseEvent,
  lastButtonClickAt: { current: number },
  onTranslate: (text: string) => void,
): void {
  hideSelectionButton();

  const btn = document.createElement('div');
  btn.className = 'fullscene-selection-button';
  btn.textContent = '译';
  btn.title = '翻译选中文本';
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-label', '翻译选中文本');
  btn.style.cssText =
    'position:fixed;z-index:2147483646;padding:4px 10px;background:#1677ff;color:#fff;' +
    'border-radius:6px;font:13px/1 system-ui,sans-serif;cursor:pointer;user-select:none;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.2);pointer-events:auto;';

  // 初始定位在鼠标位置右下
  btn.style.left = `${e.clientX + 8}px`;
  btn.style.top = `${e.clientY + 8}px`;

  /**
   * 触发翻译（幂等：一次点击只翻译一次）。
   *
   * 关键：在 **mousedown** 阶段就启动，不等 mouseup / click。
   * 任何依赖 click 的方案都可能被"按钮中途被移除 / 事件被页面脚本拦截"击穿，
   * 表现为「点了没反应」。用户在「译」按钮上按下 = 明确无歧义的翻译意图，
   * 代价只是失去"按下后拖走取消"，远小于点了没反应的代价。
   */
  const doTranslate = (): void => {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.textContent = '翻译中…';
    btn.style.opacity = '0.8';
    btn.style.cursor = 'default';
    onTranslate(currentSelection);
  };

  btn.addEventListener('mousedown', (ev: MouseEvent) => {
    ev.preventDefault(); // 保住页面选区
    ev.stopPropagation();
    lastButtonClickAt.current = Date.now();
    doTranslate();
  });
  btn.addEventListener('mouseup', (ev: MouseEvent) => {
    ev.preventDefault();
    // 阻断冒泡到 document 的 onSelect：否则会重建按钮（坐标跳动）
    // 并重复触发一次高亮（原文抖动）
    ev.stopPropagation();
    doTranslate();
  });
  btn.addEventListener('click', (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    // 清零抑制标记：只抑制"本次点击的 mouseup"，不误伤后续划词
    lastButtonClickAt.current = 0;
    doTranslate();
  });

  // 点击其他区域时隐藏按钮
  const onDocMouseDown = (ev: MouseEvent): void => {
    const t = ev.target as Node | null;
    if (t && (t === btn || btn.contains(t))) return;
    hideSelectionButton();
  };

  // 页面滚动时隐藏按钮（选区坐标失效）
  const onScroll = (): void => hideSelectionButton();

  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('scroll', onScroll, true);
  docMouseDownHandler = onDocMouseDown;
  docScrollHandler = onScroll;

  document.body.append(btn);
  selectionButton = btn;
}

/** 隐藏并清理浮动翻译按钮（连同 document 上的监听器一并移除） */
function hideSelectionButton(): void {
  if (docMouseDownHandler) {
    document.removeEventListener('mousedown', docMouseDownHandler, true);
    docMouseDownHandler = null;
  }
  if (docScrollHandler) {
    document.removeEventListener('scroll', docScrollHandler, true);
    docScrollHandler = null;
  }
  if (selectionButton) {
    selectionButton.remove();
    selectionButton = null;
  }
}

/** 取悬停元素的纯文本（过滤扩展覆盖层、过短/过长文本） */
function hoveredText(target: EventTarget | null): string {
  if (!(target instanceof HTMLElement)) return '';
  if (target.closest('.fullscene-tooltip, .fullscene-bilingual, .fullscene-inline, .fullscene-highlight, .fullscene-selection-button')) return '';
  const text = (target.textContent ?? '').trim();
  if (text.length < 4 || text.length > 300) return '';
  return text;
}

/** 全局单例（content script 用） */
let instance: ReturnType<typeof createHoverTranslator> | null = null;

/** 初始化悬停翻译器（绑定到 document） */
export function initHoverTranslator(deps: HoverTranslatorDeps, debounceMs: number = 250): void {
  if (instance) return;

  instance = createHoverTranslator(deps, debounceMs);
  document.addEventListener('mousemove', instance.onMove);
  document.addEventListener('mouseup', instance.onSelect);
}

/** 销毁悬停翻译器 */
export function destroyHoverTranslator(): void {
  if (instance) {
    document.removeEventListener('mousemove', instance.onMove);
    document.removeEventListener('mouseup', instance.onSelect);
    instance.destroy();
    instance = null;
  }
}