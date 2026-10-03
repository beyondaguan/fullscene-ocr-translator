/**
 * 结果渲染引擎：双语对照/仅译文/Tooltip/原位覆盖，CSS 变量 + Shadow DOM 隔离。
 * 所有样式注入 Shadow DOM，避免污染宿主页面；动画尊重 prefers-reduced-motion。
 */
import type { ContentBlock } from './dom-capture';
import type { TranslationResult } from '../types/engine';
import type { DesignTokens, RenderMode } from '../types/ui';

/** 当前渲染模式 */
let currentMode: RenderMode = 'bilingual';
/** 已渲染节点注册表（用于 destroy） */
const renderedNodes = new WeakMap<HTMLElement, { original: HTMLElement; shadowRoot: ShadowRoot }>();

/** 切换渲染模式 */
export function setMode(mode: RenderMode): void {
  currentMode = mode;
}

/** 获取当前渲染模式 */
export function getMode(): RenderMode {
  return currentMode;
}

/** 应用设计令牌（CSS 变量注入 document.head） */
export function applyTokens(tokens: DesignTokens): void {
  const styleId = 'fullscene-design-tokens';
  let style = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = styleId;
    document.head.append(style);
  }

  style.textContent = `
    :root {
      --fullscene-primary: ${tokens.primary};
      --fullscene-radius-sm: ${tokens.radius.sm}px;
      --fullscene-radius-md: ${tokens.radius.md}px;
      --fullscene-radius-lg: ${tokens.radius.lg}px;
      --fullscene-spacing-xs: ${tokens.spacing.xs}px;
      --fullscene-spacing-sm: ${tokens.spacing.sm}px;
      --fullscene-spacing-md: ${tokens.spacing.md}px;
      --fullscene-spacing-lg: ${tokens.spacing.lg}px;
      --fullscene-spacing-xl: ${tokens.spacing.xl}px;
    }
  `;
}

/**
 * 生成渲染节点。
 * @param block 原始内容块
 * @param result 翻译结果
 * @param mode 渲染模式，默认使用 currentMode
 * @param shadow 是否使用 Shadow DOM 隔离，默认 true
 */
export function render(
  block: ContentBlock,
  result: TranslationResult,
  mode: RenderMode = currentMode,
  shadow: boolean = true,
): HTMLElement {
  switch (mode) {
    case 'bilingual':
      return renderBilingual(block, result, shadow);
    case 'translation-only':
      return renderTranslationOnly(result, shadow);
    case 'tooltip':
      return renderTooltip(result, shadow);
    case 'inline':
      return renderInline(block, result, shadow);
  }
}

/** 双语对照：原文 + 译文上下排列 */
function renderBilingual(block: ContentBlock, result: TranslationResult, useShadow: boolean): HTMLElement {
  const container = document.createElement('div');
  container.className = 'fullscene-bilingual';

  const original = document.createElement('span');
  original.className = 'fullscene-original';
  original.textContent = block.text;

  const translation = document.createElement('span');
  translation.className = 'fullscene-translation';
  translation.textContent = result.text;

  container.append(original, translation);
  container.setAttribute('role', 'note');
  container.setAttribute('aria-label', '双语翻译结果');
  attachShadow(container, useShadow, `
    :host { display: block; }
    ::slotted(.fullscene-original) { display: block; }
    ::slotted(.fullscene-translation) {
      display: block;
      color: var(--fullscene-primary, #1677ff);
      margin-top: var(--fullscene-spacing-xs, 4px);
    }
    @media (prefers-reduced-motion: reduce) {
      ::slotted(.fullscene-translation) { transition: none; }
    }
  `);

  renderedNodes.set(container, { original: block.rect as unknown as HTMLElement, shadowRoot: container.shadowRoot as ShadowRoot });
  return container;
}

/** 仅译文：只显示翻译结果 */
function renderTranslationOnly(result: TranslationResult, useShadow: boolean): HTMLElement {
  const el = document.createElement('span');
  el.className = 'fullscene-translation-only';
  el.textContent = result.text;
  el.setAttribute('role', 'note');
  el.setAttribute('aria-label', '翻译结果');

  attachShadow(el, useShadow, `
    :host {
      color: var(--fullscene-primary, #1677ff);
    }
    @media (prefers-reduced-motion: reduce) {
      :host { transition: none; }
    }
  `);

  renderedNodes.set(el, { original: el, shadowRoot: el.shadowRoot as ShadowRoot });
  return el;
}

/** Tooltip 浮动层：定位在选区上方 */
function renderTooltip(result: TranslationResult, useShadow: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className = 'fullscene-tooltip';
  el.textContent = result.text;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  attachShadow(el, useShadow, `
    :host {
      position: fixed;
      z-index: 2147483647;
      padding: var(--fullscene-spacing-sm, 8px) var(--fullscene-spacing-md, 16px);
      background: var(--fullscene-primary, #1677ff);
      color: #fff;
      border-radius: var(--fullscene-radius-md, 8px);
      font-size: 14px;
      line-height: 1.5;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      pointer-events: none;
      transition: opacity 0.2s ease;
      max-width: 60vw;
    }
    @media (prefers-reduced-motion: reduce) {
      :host { transition: none; }
    }
  `);

  renderedNodes.set(el, { original: el, shadowRoot: el.shadowRoot as ShadowRoot });
  return el;
}

/** 原位覆盖：译文覆盖在原文上 */
function renderInline(_block: ContentBlock, result: TranslationResult, useShadow: boolean): HTMLElement {
  const el = document.createElement('span');
  el.className = 'fullscene-inline';
  el.textContent = result.text;
  el.setAttribute('role', 'note');
  el.setAttribute('aria-label', '译文覆盖');

  attachShadow(el, useShadow, `
    :host {
      color: var(--fullscene-primary, #1677ff);
      background: rgba(255,255,255,0.9);
      padding: 2px 4px;
      border-radius: var(--fullscene-radius-sm, 4px);
    }
    @media (prefers-reduced-motion: reduce) {
      :host { transition: none; }
    }
  `);

  renderedNodes.set(el, { original: el, shadowRoot: el.shadowRoot as ShadowRoot });
  return el;
}

/** 移除并清理渲染节点 */
export function destroy(el: HTMLElement): void {
  const record = renderedNodes.get(el);
  if (record) {
    // 清理 Shadow Root 内容
    const shadowRoot = el.shadowRoot;
    if (shadowRoot) {
      shadowRoot.innerHTML = '';
    }
  }
  el.remove();
  renderedNodes.delete(el);
}

/**
 * 挂载 Shadow Root 并注入样式。
 * 必须同时挂 <slot>：Shadow DOM 若没有插槽，宿主元素的 light DOM 子节点不会被渲染，
 * 译文会「渲染成功但看不见」。
 */
function attachShadow(element: HTMLElement, useShadow: boolean, css: string): ShadowRoot | null {
  if (!useShadow) return null;

  const shadowRoot = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  const slot = document.createElement('slot');
  shadowRoot.append(style, slot);
  return shadowRoot;
}

/** 定位 Tooltip 在指定坐标上方（自动翻转避免遮挡） */
export function positionTooltip(el: HTMLElement, x: number, y: number): void {
  el.style.left = `${x}px`;
  el.style.top = `${y - el.offsetHeight - 8}px`;

  // 边界翻转：如果上方空间不足则显示在下方
  const rect = el.getBoundingClientRect();
  if (rect.top < 0) {
    el.style.top = `${y + 8}px`;
  }
}