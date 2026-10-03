/**
 * 高亮已翻译原文：把选区安全包裹为 <mark class="fullscene-highlight">。
 *
 * 设计要点：
 * - 选区可能跨多个 DOM 节点，`Range.surroundContents` 会抛错，需回退到
 *   `extractContents()` + `insertNode()` 包裹，保证不丢文本、不抛异常。
 * - 高亮样式注入到宿主页面（全局 `<style>`），不走 Shadow DOM，因为被高亮的
 *   是页面正文元素，不是扩展自身的浮层。
 * - 尊重 `prefers-reduced-motion`。
 */

/** 注入全局高亮样式（幂等） */
export function ensureHighlightStyle(): void {
  const id = 'fullscene-highlight-style';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    mark.fullscene-highlight {
      background: rgba(22, 119, 255, 0.18);
      color: inherit;
      border-radius: 2px;
      padding: 0 1px;
    }
    @media (prefers-reduced-motion: reduce) {
      mark.fullscene-highlight { transition: none; }
    }
  `;
  document.head.append(style);
}

/**
 * 高亮给定 Range 内的原文。
 * @returns 创建的 <mark> 元素；空选区或无效 Range 返回 null
 */
export function highlightRange(range: Range): HTMLElement | null {
  if (!range || range.collapsed) return null;

  const mark = document.createElement('mark');
  mark.className = 'fullscene-highlight';

  try {
    range.surroundContents(mark);
    return mark;
  } catch {
    // 跨元素/部分选区：提取内容再包裹，避免抛错
    const frag = range.extractContents();
    mark.append(frag);
    range.insertNode(mark);
    return mark;
  }
}

/** 清除所有高亮（unwrap <mark>，保留原文文本） */
export function clearHighlights(root: Document | HTMLElement = document): void {
  root.querySelectorAll('mark.fullscene-highlight').forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}