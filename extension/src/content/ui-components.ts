/**
 * Design Token 驱动的轻量 DOM 组件库（仅 content script 侧使用）：
 * 按钮/卡片/输入框/胶囊/分隔线。所有组件消费 CSS 变量（Design Tokens），保证与 shared-ui 风格统一。
 * 注意：popup/sidebar 使用 React（shared-ui 组件），本文件仅服务于划词 Tooltip 等宿主页内浮层。
 */

/** 组件基础选项 */
interface ComponentOptions {
  className?: string;
  textContent?: string;
  onClick?: () => void;
}

/** 创建按钮 */
export function createButton(options: ComponentOptions = {}): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = `fullscene-btn${options.className ? ` ${options.className}` : ''}`;
  button.textContent = options.textContent ?? '';
  if (options.onClick) button.addEventListener('click', options.onClick);
  return button;
}

/** 创建卡片容器 */
export function createCard(options: ComponentOptions = {}): HTMLElement {
  const card = document.createElement('div');
  card.className = `fullscene-card${options.className ? ` ${options.className}` : ''}`;
  if (options.textContent) card.textContent = options.textContent;
  return card;
}

/** 创建输入框 */
export function createInput(options: ComponentOptions & { placeholder?: string; type?: string } = {}): HTMLInputElement {
  const input = document.createElement('input');
  input.className = `fullscene-input${options.className ? ` ${options.className}` : ''}`;
  input.type = options.type ?? 'text';
  if (options.placeholder) input.placeholder = options.placeholder;
  return input;
}

/** 创建胶囊标签 */
export function createTag(options: ComponentOptions = {}): HTMLElement {
  const tag = document.createElement('span');
  tag.className = `fullscene-tag${options.className ? ` ${options.className}` : ''}`;
  tag.textContent = options.textContent ?? '';
  return tag;
}

/** 创建分隔线 */
export function createDivider(): HTMLElement {
  const divider = document.createElement('hr');
  divider.className = 'fullscene-divider';
  return divider;
}