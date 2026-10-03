/**
 * Background Service Worker 入口。
 * 注册快捷键、初始化引擎路由、处理 Native Messaging、响应 content script 与 popup/sidebar 消息。
 */
import { translateWithFallback } from './engine-router';
import { registerDefaultEngines, syncEngineConfig } from './engines';
import { connect, captureTranslate, selectCaptureTranslate } from '../nm/client';
import { loadConfig } from '../shared/storage';
import { saveSidebarDraft } from '../shared/store';
import type { CaptureTarget } from '../types/message';

/** 右键菜单 id */
const MENU_TRANSLATE_SELECTION = 'fullscene-translate-selection';

/**
 * 引擎注册放在模块顶层（而非只在 init() 里）。
 * MV3 的 Service Worker 会随时被回收重启，且 init() 内还有 await/try 分支；
 * 注册是幂等的，放在这里能保证"只要收到翻译消息，引擎一定已就绪"，
 * 避免真机上报「没有可用的翻译引擎」。
 */
registerDefaultEngines();

/** 初始化 background */
async function init(): Promise<void> {
  // 装配并注册翻译引擎（无这一步 selectEngine 必然抛「没有可用的翻译引擎」）
  registerDefaultEngines();
  const config = await loadConfig();
  // 把保存的 SiliconFlow/OpenAI key 同步进引擎实例
  syncEngineConfig(config);

  // 注册快捷键命令
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'translate-selection') void handleTranslateSelection();
    if (command === 'open-sidebar') void openSidebar();
  });

  // 右键菜单：选中文本后右键可直接翻译
  setupContextMenus();

  // Native Messaging 连接（软件主体未安装时静默跳过；捕获翻译走运行时 sendMessage 自动重连）
  try {
    connect();
  } catch {
    // 软件主体未连接
  }
}

/** 快捷键：翻译当前页选中文本 */
async function handleTranslateSelection(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  let response: { text?: string } | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tab.id, { type: 'get-selection' })) as { text?: string } | undefined;
  } catch {
    // content script 未注入（如浏览器内置页 / PDF 阅读器）：注入后重试一次
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => undefined);
    response = (await chrome.tabs.sendMessage(tab.id, { type: 'get-selection' })) as { text?: string } | undefined;
  }

  const originalText = response?.text;
  if (!originalText) {
    await notifyTab(tab.id, { type: 'show-translation-error', message: '当前页面没有选中文字' });
    return;
  }

  try {
    const config = await loadConfig();
    const result = await translateWithFallback(
      originalText,
      {
        sourceLang: config.translation.sourceLang,
        targetLang: config.translation.targetLang,
      },
      config.translation.fallbackChain,
      config.privacy,
      config.terminology,
    );
    await notifyTab(tab.id, { type: 'show-translation', result, originalText });
  } catch (error) {
    // 显式上报错误，避免快捷键按下后"毫无反应"
    await notifyTab(tab.id, {
      type: 'show-translation-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 创建右键菜单（Service Worker 重启后需重建，故包在 try 内幂等创建） */
function setupContextMenus(): void {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_TRANSLATE_SELECTION,
        title: '翻译选中文本',
        contexts: ['selection'],
      });
    });
  } catch {
    // 权限或环境不支持：静默降级（快捷键 Alt+T 仍可用）
  }
}

/** 右键菜单点击：翻译选中文本并交给 content script 渲染（完整浮窗 / 轻量渲染） */
async function handleContextTranslate(
  selectionText: string | undefined,
  tabId: number | undefined,
): Promise<void> {
  const originalText = selectionText?.trim();
  if (!originalText || typeof tabId !== 'number') return;

  try {
    const config = await loadConfig();
    const result = await translateWithFallback(
      originalText,
      {
        sourceLang: config.translation.sourceLang,
        targetLang: config.translation.targetLang,
      },
      config.translation.fallbackChain,
      config.privacy,
      config.terminology,
    );
    await notifyTab(tabId, { type: 'show-selection-result', result, originalText });
  } catch (error) {
    await notifyTab(tabId, {
      type: 'show-translation-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 打开侧栏翻译 */
async function openSidebar(): Promise<void> {
  try {
    // Chrome 116+ 支持 sidePanel.open（需用户手势）；getLastFocused 理论上必有 id
    const win = await chrome.windows.getLastFocused();
    if (typeof win.id === 'number') {
      await chrome.sidePanel.open({ windowId: win.id });
    }
  } catch {
    // 不支持或非用户手势：静默
  }
}

/** 向页面投递消息；页面已关闭或无 content script 时静默 */
async function notifyTab(tabId: number, message: Record<string, unknown>): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // 无接收端：静默
  }
}

/** 处理来自 content script / popup / sidebar 的消息 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'translate') {
    void (async () => {
      const config = await loadConfig();
      try {
        const result = await translateWithFallback(
          message.text,
          {
            sourceLang: message.sourceLang ?? config.translation.sourceLang,
            targetLang: message.targetLang ?? config.translation.targetLang,
          },
          config.translation.fallbackChain,
          config.privacy,
          config.terminology,
        );
        sendResponse({ ok: true, translation: result.text, engine: result.engine });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return true; // 异步响应
  }

  if (message.type === 'capture-translate') {
    void (async () => {
      try {
        const target = (message.target as CaptureTarget | undefined) ?? { mode: 'Primary' };
        const dst = (message.dst as string | undefined) ?? 'zh';
        const result = await captureTranslate(target, dst);
        sendResponse({ ok: true, ocrText: result.ocrText, translation: result.translation });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return true; // 异步响应
  }

  if (message.type === 'select-capture-translate') {
    void (async () => {
      try {
        const dst = (message.dst as string | undefined) ?? 'zh';
        const result = await selectCaptureTranslate(dst);
        sendResponse({ ok: true, ocrText: result.ocrText, translation: result.translation });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return true; // 异步响应
  }

  if (message.type === 'open-ai-chat') {
    // AI 对话在软件主体实现（Alt+3）。此处通过 NM 通知软件主体打开 AI 对话页。
    void (async () => {
      try {
        await captureTranslate({ mode: 'Primary' }, 'zh'); // 保活探测（可替换为专用指令）
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false, error: '软件主体未运行' });
      }
    })();
    return true;
  }

  if (message.type === 'update-engine-config') {
    // popup/sidebar 保存引擎配置后，同步 key 到 background 的引擎实例
    void (async () => {
      const config = await loadConfig();
      syncEngineConfig(config);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'push-to-sidebar') {
    // 浮窗「送侧栏」：写入草稿后打开侧栏，侧栏读取后自动填入并清空草稿
    void (async () => {
      const payload = message.payload as { sourceText?: string; translatedText?: string } | undefined;
      if (payload?.sourceText) {
        await saveSidebarDraft({ sourceText: payload.sourceText, translatedText: payload.translatedText ?? '' });
      }
      await openSidebar();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// 右键菜单点击（模块级注册一次；contextMenus 不可用时静默）
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_TRANSLATE_SELECTION) {
    void handleContextTranslate(info.selectionText, tab?.id);
  }
});

void init();