/**
 * 扩展端本地存储：翻译历史与生词本（chrome.storage.local）。
 * 侧栏面板展示最近翻译，生词本供学习模块后续复用。
 */

/** 历史条目 */
export interface HistoryItem {
  id: string;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  engine: string;
  ts: number;
}

/** 生词条目 */
export interface VocabularyItem {
  id: string;
  term: string;
  translation: string;
  sourceLang: string;
  targetLang: string;
  ts: number;
  /** 复习次数 */
  reviewCount: number;
  /** 是否收藏（收藏项在列表中置顶，便于重点回顾） */
  favorite: boolean;
}

const HISTORY_KEY = 'fullscene.history';
const VOCAB_KEY = 'fullscene.vocabulary';
/** 侧栏待办草稿：浮窗「送侧栏」写入，侧栏读取后清空 */
const SIDEBAR_DRAFT_KEY = 'fullscene.sidebarDraft';
const MAX_HISTORY = 100;

/** 侧栏草稿内容 */
export interface SidebarDraft {
  sourceText: string;
  translatedText: string;
  ts: number;
}

/** 生成简易 id */
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 读取历史 */
export async function loadHistory(): Promise<HistoryItem[]> {
  try {
    const raw = await chrome.storage.local.get(HISTORY_KEY);
    const list = raw[HISTORY_KEY];
    return Array.isArray(list) ? (list as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

/** 追加历史（去重 + 截断） */
export async function addHistory(item: Omit<HistoryItem, 'id' | 'ts'>): Promise<HistoryItem[]> {
  const list = await loadHistory();
  const entry: HistoryItem = { ...item, id: genId(), ts: Date.now() };
  const next = [entry, ...list.filter((h) => h.sourceText !== item.sourceText)].slice(0, MAX_HISTORY);
  try {
    await chrome.storage.local.set({ [HISTORY_KEY]: next });
  } catch {
    // 忽略
  }
  return next;
}

/** 清空历史 */
export async function clearHistory(): Promise<void> {
  try {
    await chrome.storage.local.remove(HISTORY_KEY);
  } catch {
    // 忽略
  }
}

/** 读取生词本 */
export async function loadVocabulary(): Promise<VocabularyItem[]> {
  try {
    const raw = await chrome.storage.local.get(VOCAB_KEY);
    const list = raw[VOCAB_KEY];
    if (!Array.isArray(list)) return [];
    // 向后兼容：旧版本写入的条目没有 favorite 字段，补齐默认值
    return (list as VocabularyItem[]).map((v) => ({ ...v, favorite: v.favorite === true }));
  } catch {
    return [];
  }
}

/** 列表排序：收藏置顶，其次按加入时间倒序 */
export function sortVocabulary(list: VocabularyItem[]): VocabularyItem[] {
  return [...list].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return b.ts - a.ts;
  });
}

/** 添加生词（已存在则跳过） */
export async function addVocabulary(
  item: Omit<VocabularyItem, 'id' | 'ts' | 'reviewCount' | 'favorite'>,
): Promise<VocabularyItem[]> {
  const list = await loadVocabulary();
  if (list.some((v) => v.term === item.term && v.sourceLang === item.sourceLang)) return list;
  const entry: VocabularyItem = {
    ...item,
    id: genId(),
    ts: Date.now(),
    reviewCount: 0,
    favorite: false,
  };
  const next = [entry, ...list];
  try {
    await chrome.storage.local.set({ [VOCAB_KEY]: next });
  } catch {
    // 忽略
  }
  return next;
}

/** 移除生词 */
export async function removeVocabulary(id: string): Promise<VocabularyItem[]> {
  const list = await loadVocabulary();
  const next = list.filter((v) => v.id !== id);
  try {
    await chrome.storage.local.set({ [VOCAB_KEY]: next });
  } catch {
    // 忽略
  }
  return next;
}

/** 切换生词收藏状态（收藏项在列表中置顶） */
export async function toggleVocabFavorite(id: string): Promise<VocabularyItem[]> {
  const list = await loadVocabulary();
  const next = list.map((v) => (v.id === id ? { ...v, favorite: !v.favorite } : v));
  try {
    await chrome.storage.local.set({ [VOCAB_KEY]: next });
  } catch {
    // 忽略
  }
  return next;
}

/** 清空生词本 */
export async function clearVocabulary(): Promise<void> {
  try {
    await chrome.storage.local.remove(VOCAB_KEY);
  } catch {
    // 忽略
  }
}

/** 写入侧栏草稿（浮窗「送侧栏」） */
export async function saveSidebarDraft(draft: Omit<SidebarDraft, 'ts'>): Promise<void> {
  try {
    await chrome.storage.local.set({ [SIDEBAR_DRAFT_KEY]: { ...draft, ts: Date.now() } });
  } catch {
    // 忽略
  }
}

/** 读取侧栏草稿 */
export async function loadSidebarDraft(): Promise<SidebarDraft | undefined> {
  try {
    const raw = await chrome.storage.local.get(SIDEBAR_DRAFT_KEY);
    const draft = raw[SIDEBAR_DRAFT_KEY] as SidebarDraft | undefined;
    return draft?.sourceText ? draft : undefined;
  } catch {
    return undefined;
  }
}

/** 清除侧栏草稿（侧栏消费后调用） */
export async function clearSidebarDraft(): Promise<void> {
  try {
    await chrome.storage.local.remove(SIDEBAR_DRAFT_KEY);
  } catch {
    // 忽略
  }
}