/**
 * DOM 内容采集：正文区域识别、MutationObserver 动态监听、文本清洗与分块。
 * 纯 DOM 操作，可在 jsdom 下测试。
 */

/** 内容块：提取的文本及其位置信息 */
export interface ContentBlock {
  text: string;
  rect: DOMRect;
  isCode: boolean;
}

/** 正文区域识别配置 */
interface CaptureConfig {
  /** 正文候选标签 */
  contentTags: string[];
  /** 跳过标签 */
  skipTags: string[];
  /** 最小文本长度（字符数） */
  minLength: number;
}

const DEFAULT_CONFIG: CaptureConfig = {
  contentTags: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'article', 'section', 'main', 'div', 'span', 'li', 'td', 'code', 'pre'],
  skipTags: ['nav', 'aside', 'header', 'footer', 'script', 'style', 'noscript', 'svg', 'form'],
  minLength: 2,
};

/** 判断元素是否在跳过标签内 */
function isInsideSkipTag(element: Element, config: CaptureConfig): boolean {
  let current: Element | null = element;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (config.skipTags.includes(tag)) return true;
    current = current.parentElement;
  }
  return false;
}

/** 判断元素是否为代码块 */
function isCodeElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return tag === 'code' || tag === 'pre';
}

/** 判断元素是否可见（不为 display:none / visibility:hidden / hidden） */
function isVisible(element: Element): boolean {
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

/** 清洗文本：去多余空白、合并断行、去首尾空白 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/** 按句子边界分块，避免截断语义；每块不超过 maxLen 字符 */
export function splitChunks(text: string, maxLen: number = 4000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  const sentences = text.split(/(?<=[。！？.!?;；\n])/);
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim().length > 0) chunks.push(current.trim());

  // 超长句强制按字符切分
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxLen) {
      result.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += maxLen) {
        result.push(chunk.slice(i, i + maxLen));
      }
    }
  }
  return result;
}

/**
 * 提取正文文本块。
 * 用可读性启发（段落密度/链接比）定位正文，剔除 nav/aside/code 噪声。
 * @param root 根元素，默认 document.body
 */
export function capture(root: Element = document.body, config: CaptureConfig = DEFAULT_CONFIG): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const elements = root.querySelectorAll(config.contentTags.join(','));

  for (const element of Array.from(elements)) {
    if (isInsideSkipTag(element, config)) continue;
    if (!isVisible(element)) continue;

    const isCode = isCodeElement(element);
    const text = cleanText(element.textContent ?? '');
    if (text.length < config.minLength) continue;

    // 链接密度过高 → 导航区域，跳过
    const links = element.querySelectorAll('a');
    const linkTextLength = Array.from(links).reduce((sum, link) => sum + (link.textContent?.length ?? 0), 0);
    if (text.length > 0 && linkTextLength / text.length > 0.5) continue;

    blocks.push({
      text,
      rect: element.getBoundingClientRect(),
      isCode,
    });
  }

  return blocks;
}

/**
 * 监听 DOM 变化，去抖后回调。
 * 返回 MutationObserver 实例，调用 disconnect() 停止监听。
 */
export function observe(
  root: Element,
  cb: (blocks: ContentBlock[]) => void,
  config: CaptureConfig = DEFAULT_CONFIG,
  debounceMs: number = 250,
): MutationObserver {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      cb(capture(root, config));
    }, debounceMs);
  };

  const observer = new MutationObserver(() => {
    schedule();
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return observer;
}

/** 捕获整个 document.body 的便捷方法 */
export function captureDocument(): ContentBlock[] {
  return capture(document.body);
}