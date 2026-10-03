/**
 * Content Script 入口。
 * 初始化悬停翻译器（划词/实时翻译），监听 background 消息：
 * - get-selection：返回当前选中文本（快捷键划词翻译用）
 * - show-translation / show-translation-error：渲染译文/错误提示
 * - translate-page / restore-page：全文翻译与还原（模式1）
 *
 * 配置热更新：chrome.storage.onChanged 监听 appConfig 变化后重建悬停翻译器，
 * 使 options/popup/sidebar 保存的设置立即生效（不再需要重新加载页面）。
 */
import { initHoverTranslator, destroyHoverTranslator } from './hover-translator';
import { capture } from './dom-capture';
import { render, applyTokens, destroy, setMode } from './renderer';
import { DEFAULT_TOKENS } from '../types/ui';
import type { TranslationResult } from '../types/engine';
import { highlightRange, ensureHighlightStyle, clearHighlights } from './highlight';
import { loadConfig } from '../shared/storage';
import { createReadAloudButton } from '../shared/tts';
import { showFloatingPanel, hideFloatingPanel } from './floating-panel';
import { addHistory, addVocabulary } from '../shared/store';
import { apiPushToSidebar } from '../shared/api';
import type { AppConfig } from '../types/config';

/**
 * 防重复注入标记。
 * background 在"content script 不存在"时会补注入一次 content.js；
 * 不设这道闸门会在同一帧里重复执行 init()，导致悬停翻译双触发、ESC 监听叠加。
 * 挂在 window 上才能跨模块重复求值生效。
 */
function markContentInjected(): boolean {
  const key = '__fullsceneContentReady';
  if ((window as unknown as Record<string, unknown>)[key] === true) return false;
  (window as unknown as Record<string, unknown>)[key] = true;
  return true;
}

/**
 * 当前生效的划词结果渲染函数。
 * 由 applyConfig 写入，供消息通道（右键菜单翻译）复用同一套渲染逻辑。
 */
let renderSelection: (result: TranslationResult, originalText: string) => void = () => undefined;

/**
 * 应用配置到悬停翻译器（可重入：先销毁旧实例，再用新配置重建）。
 */
function applyConfig(cfg: AppConfig): void {
  // 让快捷键划词翻译按用户选择的展示方式渲染（气泡/双语/仅译文/原位）
  setMode(cfg.display.mode);

  // 销毁旧实例（若有），避免事件监听叠加
  destroyHoverTranslator();

  // 消息通道（右键菜单翻译）复用同一套渲染逻辑
  renderSelection = (result, originalText) => renderSelectionImpl(cfg, result, originalText);

  // 划词翻译失败提示节流（悬停模式失败频繁，3 秒内只提示一次）
  let lastErrorAt = 0;

  initHoverTranslator({
    realtime: cfg.display.realtime,
    selectionMode: cfg.display.selectionMode,
    translate: async (text: string): Promise<TranslationResult> => {
      const response = await chrome.runtime.sendMessage({
        type: 'translate',
        text,
        sourceLang: cfg.translation.sourceLang,
        targetLang: cfg.translation.targetLang,
      });
      if (response?.ok) return { text: response.translation, engine: response.engine };
      throw new Error(response?.error ?? '翻译失败');
    },
    showTooltip: (result, at) => {
      hideAllTooltips();
      const el = render({ text: '', rect: new DOMRect(0, 0, 0, 0), isCode: false }, result, 'tooltip');
      el.style.left = `${at.x}px`;
      el.style.top = `${at.y - 40}px`;
      el.append(createReadAloudButton(result.text, cfg.translation.targetLang));
      document.body.append(el);
      setTimeout(() => destroy(el), 3000);
    },
    hideTooltip: hideAllTooltips,
    // 按钮/自动划词翻译：默认打开完整翻译浮窗（可拖动、朗读/记录/生词/复制/送侧栏）
    renderSelectionResult: (result, originalText, at) => {
      renderSelectionImpl(cfg, result, originalText, at);
    },
    highlightSource: (range) => {
      if (cfg.display.highlight) highlightRange(range);
    },
    // 划词翻译失败必须给出可见提示，否则用户只会看到「点了没反应」
    onError: (message) => {
      const now = Date.now();
      if (now - lastErrorAt < 3000) return;
      lastErrorAt = now;
      showTranslationError(message);
    },
  });
}

/**
 * 划词翻译结果渲染：默认打开完整翻译浮窗，轻量模式按展示方式直接渲染到页面。
 */
function renderSelectionImpl(
  cfg: AppConfig,
  result: TranslationResult,
  originalText: string,
  at?: { x: number; y: number },
): void {
  if (cfg.display.mode === 'tooltip' && cfg.display.panelMode !== 'panel') {
    // 气泡模式（且未启用完整浮窗）：直接在选区位置弹出气泡（3 秒自动消失）
    const el = render({ text: '', rect: new DOMRect(0, 0, 0, 0), isCode: false }, result, 'tooltip');
    if (at) {
      el.style.left = `${at.x}px`;
      el.style.top = `${at.y - 40}px`;
    }
    el.append(createReadAloudButton(result.text, cfg.translation.targetLang));
    document.body.append(el);
    setTimeout(() => destroy(el), 3000);
    return;
  }

  // 默认：打开完整翻译浮窗
  showFloatingPanel(
    originalText,
    result,
    {
      readLang: cfg.translation.targetLang,
      sourceLang: cfg.translation.sourceLang,
      targetLang: cfg.translation.targetLang,
      onRetranslate: async (text) => {
        const resp = await chrome.runtime.sendMessage({
          type: 'translate',
          text,
          sourceLang: cfg.translation.sourceLang,
          targetLang: cfg.translation.targetLang,
        });
        if (resp?.ok) return { text: resp.translation, engine: resp.engine };
        throw new Error(resp?.error ?? '翻译失败');
      },
      onSave: async (item) => {
        await addHistory(item);
      },
      onAddVocabulary: async (item) => {
        await addVocabulary(item);
      },
      onSendToSidebar: async (payload) => {
        await apiPushToSidebar(payload);
      },
    },
    at,
  );
}

/** 初始化 content script */
async function init(): Promise<void> {
  if (!markContentInjected()) return;

  applyTokens(DEFAULT_TOKENS);
  ensureHighlightStyle();

  const cfg = await loadConfig();
  applyConfig(cfg);

  // 配置热更新：options/popup/sidebar 保存后，storage 变化会触发此监听
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes['appConfig']) return;
    void (async () => {
      const next = await loadConfig();
      applyConfig(next);
    })();
  });

  // ESC 关闭所有浮层（a11y：键盘可达的退出路径）
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      hideAllTooltips();
      hideFloatingPanel();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'get-selection') {
      sendResponse({ text: window.getSelection()?.toString() ?? '' });
      return false;
    }
    if (message.type === 'show-translation') {
      showTranslation(message.result as TranslationResult, message.originalText as string | undefined);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'show-translation-error') {
      showTranslationError(message.message as string);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'show-selection-result') {
      // 右键菜单「翻译选中文本」：复用划词渲染逻辑（完整浮窗 / 轻量渲染）
      renderSelection(message.result as TranslationResult, message.originalText as string);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'translate-page') {
      void handleTranslatePage(sendResponse);
      return true;
    }
    if (message.type === 'restore-page') {
      handleRestorePage();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
}

/**
 * 模式1 · 全文翻译：采集正文 → 逐块翻译 → DOM 原地替换（保留排版，可还原）。
 */
async function handleTranslatePage(sendResponse: (response: unknown) => void): Promise<void> {
  try {
    const cfg = await loadConfig();
    const blocks = capture(document.body);
    if (blocks.length === 0) {
      sendResponse({ ok: false, error: '未检测到可翻译的正文内容' });
      return;
    }

    // 全文翻译模式：bilingual=保留原文、译文追加其下；translation-only=隐藏原文只留译文
    const pageMode = cfg.display.pageMode ?? 'bilingual';
    const targets = blocks.filter((b) => b.text.trim().length > 0);
    let done = 0;
    for (const block of targets) {
      const text = block.text.trim();
      const response = await chrome.runtime.sendMessage({
        type: 'translate',
        text,
        sourceLang: cfg.translation.sourceLang,
        targetLang: cfg.translation.targetLang,
      });
      if (!response?.ok) continue;

      const anchor = elementAtRect(block.rect);
      if (!anchor?.parentElement) continue;

      // 「仅译文」模式：先把原文节点隐藏（记录原 display，便于还原）
      if (pageMode === 'translation-only') {
        const el = anchor as HTMLElement;
        if (el.dataset.fullsceneHidden !== '1') {
          el.dataset.fullsceneHidden = '1';
          el.dataset.fullsceneDisplay = el.style.display || '';
          el.style.display = 'none';
        }
      }

      const node = render(block, { text: response.translation, engine: response.engine }, 'translation-only');
      node.setAttribute('data-fullscene-page', '1');
      anchor.parentElement.insertBefore(node, anchor.nextSibling);
      done += 1;
    }

    sendResponse({ ok: true, translated: done, total: targets.length });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** 模式1 · 还原原文：移除译文节点、恢复被隐藏的原文 */
function handleRestorePage(): void {
  document.querySelectorAll('[data-fullscene-page]').forEach((el) => destroy(el as HTMLElement));
  document.querySelectorAll<HTMLElement>('[data-fullscene-hidden="1"]').forEach((el) => {
    el.style.display = el.dataset.fullsceneDisplay ?? '';
    delete el.dataset.fullsceneHidden;
    delete el.dataset.fullsceneDisplay;
  });
  clearHighlights();
}

/** 隐藏并清理所有 Tooltip */
function hideAllTooltips(): void {
  document.querySelectorAll('.fullscene-tooltip').forEach((el) => destroy(el as HTMLElement));
}

/** 以用户配置的展示方式把译文插入到原文之后（快捷键划词翻译结果） */
function showTranslation(result: TranslationResult, originalText?: string): void {
  const blocks = capture(document.body);
  for (const block of blocks) {
    if (originalText && !block.text.includes(originalText)) continue;

    const parent = findElementByText(block.text);
    if (!parent) continue;

    // 使用用户配置的渲染模式（气泡/双语/仅译文/原位）
    const el = render(block, result);
    parent.after(el);
    break;
  }
}

/** 翻译失败时于视口右上角给出可点击关闭的提示 */
function showTranslationError(message: string): void {
  const el = document.createElement('div');
  el.className = 'fullscene-tooltip';
  el.setAttribute('role', 'alert');
  el.textContent = `翻译失败：${message}`;
  el.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:60vw;padding:10px 14px;' +
    'border-radius:8px;background:#fff2f0;border:1px solid #ffccc7;color:#a8071a;' +
    'font:13px/1.5 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.18);cursor:pointer';
  document.body.append(el);

  const timer = window.setTimeout(() => destroy(el), 8000);
  el.addEventListener('click', () => {
    window.clearTimeout(timer);
    destroy(el);
  });
}

/** 按文本内容定位元素 */
function findElementByText(text: string): Element | null {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node.textContent?.includes(text)) return node.parentElement;
    node = walker.nextNode();
  }
  return null;
}

/** 用 DOMRect 中心点定位元素（全文翻译插入锚点） */
function elementAtRect(rect: DOMRect): Element | null {
  if (rect.width === 0 && rect.height === 0) return null;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const el = document.elementFromPoint(x, y);
  return el instanceof Element ? el : null;
}

void init();