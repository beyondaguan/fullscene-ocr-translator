/**
 * 划词完整翻译浮窗（参考 WinOCR-Html 的常驻翻译栏设计）。
 *
 * 与轻量「译」按钮不同，浮窗是一个带标题栏/原文区/译文区的常驻面板：
 * - 标题栏可拖动（按住拖动）
 * - 打开即自动翻译（由调用方传入译文）
 * - 头部按钮：译（重译）、×（关闭）
 * - 底部操作条：朗读、记录（写历史）、＋生词（写生词本）、复制、送侧栏
 * - 面板内 mousedown preventDefault，避免夺走页面选区
 * - 点面板外部不自动关闭（常驻），右上角 × 关闭；Esc 也可关闭
 *
 * 样式用 Shadow DOM 隔离，避免污染宿主页面。
 */
import type { TranslationResult } from '../types/engine';
import type { HistoryItem, VocabularyItem } from '../shared/store';
import { speak } from '../shared/tts';

/** 浮窗操作回调 */
export interface FloatingPanelActions {
  /** 重译：重新翻译当前原文 */
  onRetranslate?: (originalText: string) => Promise<TranslationResult>;
  /** 记录：把原文/译文写入历史 */
  onSave?: (item: Omit<HistoryItem, 'id' | 'ts'>) => Promise<void>;
  /** ＋生词：把原文/译文写入生词本 */
  onAddVocabulary?: (item: Omit<VocabularyItem, 'id' | 'ts' | 'reviewCount' | 'favorite'>) => Promise<void>;
  /** 送侧栏：把当前原文/译文推送到侧栏继续处理 */
  onSendToSidebar?: (payload: { sourceText: string; translatedText: string }) => Promise<void>;
  /** 朗读语言（目标语言），缺省 zh */
  readLang?: string;
  /** 源语言（生词本记录用），缺省 auto */
  sourceLang?: string;
  /** 目标语言（历史/生词本记录用），缺省 zh */
  targetLang?: string;
}

/** 当前浮窗实例（全局唯一） */
let panel: HTMLElement | null = null;
let panelCleanup: (() => void) | null = null;

/** 注入样式（Shadow DOM 内） */
function panelStyle(): string {
  return `
    :host {
      all: initial;
    }
    .fs-panel {
      position: fixed;
      z-index: 2147483647;
      width: 380px;
      max-width: calc(100vw - 24px);
      background: #fff;
      border: 0.5px solid #e3e8ef;
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .08);
      font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
            "Microsoft YaHei", system-ui, sans-serif;
      color: #1f2937;
      overflow: hidden;
      user-select: none;
      animation: fs-in .16s cubic-bezier(.16, 1, .3, 1);
    }
    @keyframes fs-in {
      from { opacity: 0; transform: translateY(6px) scale(.985); }
      to   { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .fs-panel { animation: none; }
    }
    .fs-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 8px 8px 14px;
      background: linear-gradient(180deg, #f8fafc, #f1f5f9);
      border-bottom: 0.5px solid #e8edf3;
      cursor: move;
    }
    .fs-grip {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: .02em;
      color: #1677ff;
    }
    .fs-grip::before {
      content: '⠿ ';
      color: #a9b6c6;
    }
    .fs-btns {
      display: inline-flex;
      gap: 4px;
    }
    .fs-btns button {
      font: 12px/1 inherit;
      border: 0.5px solid #dbe2ea;
      background: #fff;
      border-radius: 7px;
      padding: 4px 10px;
      cursor: pointer;
      color: #475569;
      transition: background .14s ease, color .14s ease, border-color .14s ease;
    }
    .fs-btns button:hover {
      background: #eaf3ff;
      border-color: #1677ff;
      color: #1677ff;
    }
    .fs-btns button[data-act="close"]:hover {
      background: #fff1f0;
      border-color: #ff7875;
      color: #cf1322;
    }
    .fs-src {
      padding: 10px 14px 8px;
      color: #8a94a6;
      font-size: 12.5px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 18vh;
      overflow: auto;
      user-select: text;
    }
    .fs-out {
      padding: 8px 14px 12px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 40vh;
      overflow: auto;
      border-top: 0.5px solid #f0f3f7;
      color: #1677ff;
      user-select: text;
    }
    .fs-out.is-error {
      color: #cf1322;
    }
    .fs-out.is-loading {
      color: #9aa4b2;
    }
    .fs-acts {
      display: flex;
      gap: 4px;
      padding: 6px 8px;
      border-top: 0.5px solid #eef1f6;
      background: #fbfcfe;
    }
    .fs-acts button {
      flex: 1;
      font: 12px/1 inherit;
      border: 0.5px solid transparent;
      background: transparent;
      border-radius: 7px;
      padding: 5px 2px;
      cursor: pointer;
      color: #5c6779;
      white-space: nowrap;
      transition: background .14s ease, color .14s ease;
    }
    .fs-acts button:hover {
      background: #eaf3ff;
      color: #1677ff;
    }
    .fs-acts button.is-done {
      color: #389e0d;
      background: #f6ffed;
    }
    .fs-src::-webkit-scrollbar,
    .fs-out::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    .fs-src::-webkit-scrollbar-thumb,
    .fs-out::-webkit-scrollbar-thumb {
      background: rgba(18,24,31,.2);
      border-radius: 100px;
      border: 2px solid transparent;
      background-clip: content-box;
    }
  `;
}

/** 当前面板的原文与译文（供操作按钮使用） */
interface PanelState {
  original: string;
  translation: string;
  result: TranslationResult | null;
  actions: FloatingPanelActions;
}

let panelState: PanelState | null = null;

/** 隐藏浮窗 */
export function hideFloatingPanel(): void {
  if (panelCleanup) {
    try {
      panelCleanup();
    } catch {
      // 忽略
    }
    panelCleanup = null;
  }
  if (panel) {
    panel.remove();
    panel = null;
  }
  panelState = null;
}

/** 当前浮窗是否可见 */
export function isFloatingPanelVisible(): boolean {
  return panel !== null;
}

/**
 * 显示/更新完整翻译浮窗。
 * @param originalText 原文
 * @param result 翻译结果（可为 null 表示翻译中）
 * @param actions 操作回调
 * @param at 初始定位（鼠标位置），缺省居中偏右上
 */
export function showFloatingPanel(
  originalText: string,
  result: TranslationResult | null,
  actions: FloatingPanelActions = {},
  at?: { x: number; y: number },
): HTMLElement {
  // 若已存在且原文相同：复用面板，只更新译文（避免重建导致选区/拖动状态丢失）
  if (panel && panelState && panelState.original === originalText) {
    panelState.actions = { ...panelState.actions, ...actions };
    updatePanelContent(result);
    return panel;
  }

  hideFloatingPanel();

  const host = document.createElement('div');
  host.className = 'fullscene-floating-panel';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = panelStyle();
  shadow.append(style);

  const root = document.createElement('div');
  root.className = 'fs-panel';
  root.innerHTML = `
    <div class="fs-head">
      <span class="fs-grip">划词翻译</span>
      <span class="fs-btns">
        <button data-act="trans" title="重新翻译">译</button>
        <button data-act="close" title="关闭 (Esc)">×</button>
      </span>
    </div>
    <div class="fs-src"></div>
    <div class="fs-out is-loading">翻译中…</div>
    <div class="fs-acts">
      <button data-act="speak" title="朗读译文">🔊 朗读</button>
      <button data-act="save" title="记录到历史">记录</button>
      <button data-act="vocab" title="加入生词本">＋生词</button>
      <button data-act="copy" title="复制译文">复制</button>
      <button data-act="panel" title="推送到侧栏继续处理">送侧栏</button>
    </div>
  `;
  shadow.append(root);

  // 定位
  const x = at ? Math.max(8, Math.min(at.x, window.innerWidth - 400)) : Math.max(8, window.innerWidth - 420);
  const y = at ? Math.max(8, at.y + 16) : Math.max(8, 80);
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;

  // 设置原文
  const srcEl = root.querySelector('.fs-src') as HTMLElement;
  srcEl.textContent = originalText;

  panelState = { original: originalText, translation: '', result: null, actions };

  // 拖动（标题栏）
  let drag: { sx: number; sy: number; ox: number; oy: number } | null = null;
  const head = root.querySelector('.fs-head') as HTMLElement;
  head.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    e.preventDefault();
    drag = { sx: e.clientX, sy: e.clientY, ox: parseInt(root.style.left, 10) || 0, oy: parseInt(root.style.top, 10) || 0 };
  });
  const onMove = (e: MouseEvent): void => {
    if (!drag) return;
    root.style.left = `${drag.ox + e.clientX - drag.sx}px`;
    root.style.top = `${drag.oy + e.clientY - drag.sy}px`;
  };
  const onUp = (): void => {
    drag = null;
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  // 面板内 mousedown 阻止默认（保护页面选区）
  root.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
    e.preventDefault();
  });

  /** 取当前译文 */
  const currentText = (): string =>
    panelState?.translation || (panelState?.result?.text ?? '');

  /** 按钮瞬时反馈（不覆盖译文，只改按钮文字） */
  function flash(btn: HTMLElement, text: string): void {
    const old = btn.textContent;
    btn.textContent = text;
    btn.classList.add('is-done');
    setTimeout(() => {
      if (!root.isConnected) return;
      btn.textContent = old;
      btn.classList.remove('is-done');
    }, 1200);
  }

  /** 重译 */
  async function handleRetranslate(): Promise<void> {
    if (!panelState?.actions.onRetranslate || !panelState.original) return;
    const outEl = root.querySelector('.fs-out') as HTMLElement;
    outEl.textContent = '翻译中…';
    outEl.className = 'fs-out is-loading';
    try {
      const r = await panelState.actions.onRetranslate(panelState.original);
      if (!root.isConnected) return; // 面板已关闭
      panelState.translation = r.text;
      panelState.result = r;
      outEl.textContent = r.text;
      outEl.className = 'fs-out';
    } catch (err) {
      if (!root.isConnected) return;
      outEl.textContent = `翻译失败：${err instanceof Error ? err.message : String(err)}`;
      outEl.className = 'fs-out is-error';
    }
  }

  /** 记录到历史 */
  async function handleSave(btn: HTMLElement): Promise<void> {
    if (!panelState?.actions.onSave || !panelState.original) return;
    const text = currentText();
    if (!text) return;
    try {
      await panelState.actions.onSave({
        sourceText: panelState.original,
        translatedText: text,
        sourceLang: panelState.actions.sourceLang ?? 'auto',
        targetLang: panelState.actions.targetLang ?? 'zh',
        engine: panelState.result?.engine ?? '',
      });
      flash(btn, '已记录');
    } catch {
      // 忽略
    }
  }

  /** 加入生词本 */
  async function handleVocab(btn: HTMLElement): Promise<void> {
    if (!panelState?.actions.onAddVocabulary || !panelState.original) return;
    const text = currentText();
    if (!text) return;
    try {
      await panelState.actions.onAddVocabulary({
        term: panelState.original,
        translation: text,
        sourceLang: panelState.actions.sourceLang ?? 'auto',
        targetLang: panelState.actions.targetLang ?? 'zh',
      });
      flash(btn, '已加入');
    } catch {
      // 忽略
    }
  }

  /** 复制译文 */
  async function handleCopy(btn: HTMLElement): Promise<void> {
    const text = currentText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flash(btn, '已复制');
    } catch {
      // 忽略
    }
  }

  /** 送侧栏 */
  async function handleSendPanel(btn: HTMLElement): Promise<void> {
    if (!panelState?.actions.onSendToSidebar || !panelState.original) return;
    try {
      await panelState.actions.onSendToSidebar({
        sourceText: panelState.original,
        translatedText: currentText(),
      });
      flash(btn, '已推送');
    } catch {
      // 忽略
    }
  }

  /** 朗读译文 */
  function handleSpeak(btn: HTMLElement): void {
    const text = currentText();
    if (!text) return;
    try {
      speak(text, { lang: panelState?.actions.readLang ?? 'zh' });
      flash(btn, '朗读中');
    } catch {
      // 环境不支持语音合成时静默（不影响其它操作）
    }
  }

  // 绑定按钮
  root.querySelectorAll<HTMLElement>('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'trans') void handleRetranslate();
      else if (act === 'close') hideFloatingPanel();
      else if (act === 'speak') handleSpeak(btn);
      else if (act === 'save') void handleSave(btn);
      else if (act === 'vocab') void handleVocab(btn);
      else if (act === 'copy') void handleCopy(btn);
      else if (act === 'panel') void handleSendPanel(btn);
    });
  });

  // Esc 关闭
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') hideFloatingPanel();
  };
  document.addEventListener('keydown', onKey);

  // 清理
  panelCleanup = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('keydown', onKey);
  };

  document.body.append(host);
  panel = host;

  // 初始内容
  updatePanelContent(result);

  return host;
}

/** 更新面板译文内容（复用面板时调用） */
function updatePanelContent(result: TranslationResult | null): void {
  if (!panel || !panelState) return;
  const root = panel.shadowRoot?.querySelector('.fs-panel') as HTMLElement | null;
  if (!root) return;
  const outEl = root.querySelector('.fs-out') as HTMLElement;
  if (!result) {
    outEl.textContent = '翻译中…';
    outEl.className = 'fs-out is-loading';
    return;
  }
  panelState.translation = result.text;
  panelState.result = result;
  outEl.textContent = result.text;
  outEl.className = 'fs-out';
}
