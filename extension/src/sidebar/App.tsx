/**
 * Sidebar 主界面（模式3 · 侧栏翻译）：翻译 / 历史 / 生词本 三个分区。
 *
 * - 翻译：输入即译，结果区带「朗读 / ＋生词 / 复制」操作
 * - 历史：最近 100 条，支持回填与导出 MD / ZIP / JSON
 * - 生词本：从浮窗「＋生词」沉淀，支持朗读 / 删除 / 导出 JSON / CSV
 * - 浮窗「送侧栏」的草稿会在挂载时自动读取并填入
 */
import { useCallback, useEffect, useState } from 'react';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../shared/storage';
import { apiTranslate, apiOpenAiChat, apiUpdateEngineConfig } from '../shared/api';
import {
  loadHistory,
  addHistory,
  clearHistory,
  loadVocabulary,
  removeVocabulary,
  clearVocabulary,
  addVocabulary,
  toggleVocabFavorite,
  sortVocabulary,
  loadSidebarDraft,
  clearSidebarDraft,
  type HistoryItem,
  type VocabularyItem,
} from '../shared/store';
import { download } from '../shared/download';
import { buildDailyMarkdown, dailyFileContent, groupByDate, makeZip } from '../shared/markdown';
import { loadLocale, saveLocale, t, type Locale } from '../shared/i18n';
import { speak } from '../shared/tts';
import type { AppConfig } from '../types/config';

const LANG_OPTIONS = [
  { code: 'auto', name: '自动检测' },
  { code: 'zh', name: '中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
];

const ENGINE_OPTIONS = [
  { value: 'microsoft', label: '微软翻译（免费）' },
  { value: 'siliconflow', label: 'SiliconFlow（推荐）' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'mymemory', label: 'MyMemory' },
  { value: 'ollama', label: 'Ollama（本地）' },
  { value: 'lmstudio', label: 'LM Studio（本地）' },
];

type TabKey = 'translate' | 'history' | 'vocab';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'translate', label: '翻译' },
  { key: 'history', label: '历史' },
  { key: 'vocab', label: '生词本' },
];

/** 日期时间格式化 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function App() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [tab, setTab] = useState<TabKey>('translate');
  const [text, setText] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [vocabulary, setVocabulary] = useState<VocabularyItem[]>([]);
  const [locale, setLocaleState] = useState<Locale>('zh-CN');
  const [showEngineConfig, setShowEngineConfig] = useState(false);

  useEffect(() => {
    void (async () => {
      const [cfg, loc, hist, vocab, draft] = await Promise.all([
        loadConfig(),
        loadLocale(),
        loadHistory(),
        loadVocabulary(),
        loadSidebarDraft(),
      ]);
      setConfig(cfg);
      setLocaleState(loc);
      setHistory(hist);
      setVocabulary(vocab);
      // 浮窗「送侧栏」推送过来的内容：自动填入并清空草稿
      if (draft) {
        setText(draft.sourceText);
        setResult(draft.translatedText);
        await clearSidebarDraft();
      }
    })();
  }, []);

  // 浮窗可能在侧栏已打开时再次推送：监听 storage 变化实时接收
  useEffect(() => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area !== 'local') return;
      const next = changes['fullscene.sidebarDraft']?.newValue as
        | { sourceText?: string; translatedText?: string }
        | undefined;
      if (!next?.sourceText) return;
      setText(next.sourceText);
      setResult(next.translatedText ?? '');
      setTab('translate');
      void clearSidebarDraft();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  /** 语言/引擎下拉：即改即存，并通知 background 引擎同步 */
  const patchTranslation = useCallback(
    async (key: 'sourceLang' | 'targetLang' | 'defaultEngine', value: string) => {
      const next = { ...config, translation: { ...config.translation, [key]: value } };
      setConfig(next);
      await saveConfig(next);
      await apiUpdateEngineConfig();
    },
    [config],
  );

  const onTranslate = useCallback(async () => {
    const input = text.trim();
    if (!input || busy) return;
    setBusy(true);
    try {
      const resp = await apiTranslate({
        text: input,
        sourceLang: config.translation.sourceLang,
        targetLang: config.translation.targetLang,
        engine: config.translation.defaultEngine,
      });
      setResult(resp.text);
      const next = await addHistory({
        sourceText: input,
        translatedText: resp.text,
        sourceLang: config.translation.sourceLang,
        targetLang: config.translation.targetLang,
        engine: resp.engine,
      });
      setHistory(next);
    } catch (error) {
      setResult(`错误：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [text, busy, config]);

  const onClearHistory = useCallback(async () => {
    await clearHistory();
    setHistory([]);
  }, []);

  /** 把当前原文/译文加入生词本 */
  const onAddVocab = useCallback(
    async (term: string, translation: string) => {
      if (!term.trim() || !translation.trim()) return;
      const next = await addVocabulary({
        term,
        translation,
        sourceLang: config.translation.sourceLang,
        targetLang: config.translation.targetLang,
      });
      setVocabulary(next);
    },
    [config],
  );

  const onRemoveVocab = useCallback(async (id: string) => {
    const next = await removeVocabulary(id);
    setVocabulary(next);
  }, []);

  const onToggleFav = useCallback(async (id: string) => {
    const next = await toggleVocabFavorite(id);
    setVocabulary(next);
  }, []);

  const onClearVocab = useCallback(async () => {
    await clearVocabulary();
    setVocabulary([]);
  }, []);

  /** 导出历史为 Markdown 单文件 */
  const onExportMarkdown = useCallback(() => {
    if (history.length === 0) return;
    const md = buildDailyMarkdown(history);
    download(new Blob([md], { type: 'text/markdown' }), `FullScene-${new Date().toISOString().slice(0, 10)}.md`);
  }, [history]);

  /** 导出历史为 ZIP（按日拆分 MD） */
  const onExportZip = useCallback(() => {
    if (history.length === 0) return;
    const groups = groupByDate(history);
    const files = Object.keys(groups)
      .sort()
      .map((date) => ({
        name: `FullScene-${date}.md`,
        data: new TextEncoder().encode(dailyFileContent(date, groups[date])),
      }));
    download(makeZip(files), `FullScene-${new Date().toISOString().slice(0, 10)}.zip`);
  }, [history]);

  /** 导出历史为 JSON */
  const onExportJson = useCallback(() => {
    if (history.length === 0) return;
    download(
      new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' }),
      `fullscene-history-${new Date().toISOString().slice(0, 10)}.json`,
    );
  }, [history]);

  /** 导出生词本（JSON / CSV） */
  const onExportVocab = useCallback(
    (format: 'json' | 'csv') => {
      if (vocabulary.length === 0) return;
      const stamp = new Date().toISOString().slice(0, 10);
      const ordered = sortVocabulary(vocabulary);
      if (format === 'json') {
        download(
          new Blob([JSON.stringify(ordered, null, 2)], { type: 'application/json' }),
          `fullscene-vocabulary-${stamp}.json`,
        );
        return;
      }
      // 划词原文可能含换行/引号，必须转义，否则 CSV 结构被破坏
      const esc = (s: string): string => `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
      const rows = [['term', 'translation', 'sourceLang', 'targetLang', 'favorite', 'time'].join(',')];
      for (const v of ordered) {
        rows.push(
          [esc(v.term), esc(v.translation), v.sourceLang, v.targetLang, v.favorite ? '1' : '0', formatTime(v.ts)].join(
            ',',
          ),
        );
      }
      download(new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' }), `fullscene-vocabulary-${stamp}.csv`);
    },
    [vocabulary],
  );

  const onLocaleChange = useCallback(async (value: string) => {
    const loc = value as Locale;
    setLocaleState(loc);
    await saveLocale(loc);
  }, []);

  /** 保存引擎配置并通知 background 即时生效 */
  const saveEngineConfig = useCallback(async () => {
    await saveConfig(config);
    await apiUpdateEngineConfig();
    setShowEngineConfig(false);
  }, [config]);

  const selectedEngine = config.translation.defaultEngine;
  const engineProfile =
    selectedEngine === 'siliconflow'
      ? config.translation.siliconflow
      : selectedEngine === 'openai'
        ? config.translation.openai
        : undefined;

  /** 朗读（失败时静默，避免打断主流程） */
  const readAloud = useCallback(
    (value: string) => {
      try {
        speak(value, { lang: config.translation.targetLang });
      } catch {
        // 环境不支持语音合成
      }
    },
    [config.translation.targetLang],
  );

  /** 复制文本到剪贴板 */
  const copyText = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // 忽略
    }
  }, []);

  return (
    <div className="fs-app fs-app--sidebar">
      <div className="fs-header">
        <div className="fs-brand">
          <span className="fs-mark">译</span>
          <div>
            <div className="fs-title">{t('app.title', {}, locale)}</div>
            <div className="fs-sub">侧栏翻译 · 历史 · 生词本</div>
          </div>
        </div>
        <select
          className="fs-select"
          style={{ width: 88 }}
          value={locale}
          onChange={(e) => void onLocaleChange(e.target.value)}
        >
          <option value="zh-CN">中文</option>
          <option value="en">EN</option>
        </select>
      </div>

      <div className="fs-tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            className={`fs-tab${tab === item.key ? ' is-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
            {item.key === 'vocab' && vocabulary.length > 0 ? ` (${vocabulary.length})` : ''}
          </button>
        ))}
      </div>

      {tab === 'translate' ? (
        <>
          <div className="fs-card">
            <div className="fs-row" style={{ marginBottom: 8 }}>
              <select
                className="fs-select"
                value={config.translation.sourceLang}
                onChange={(e) => void patchTranslation('sourceLang', e.target.value)}
              >
                {LANG_OPTIONS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.name}
                  </option>
                ))}
              </select>
              <select
                className="fs-select"
                value={config.translation.targetLang}
                onChange={(e) => void patchTranslation('targetLang', e.target.value)}
              >
                {LANG_OPTIONS.filter((o) => o.code !== 'auto').map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="fs-row" style={{ marginBottom: 8 }}>
              <select
                className="fs-select"
                value={config.translation.defaultEngine}
                onChange={(e) => void patchTranslation('defaultEngine', e.target.value)}
              >
                {ENGINE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button className="fs-btn fs-btn--sm" style={{ flex: 'none' }} onClick={() => setShowEngineConfig((v) => !v)}>
                配置
              </button>
            </div>

            {showEngineConfig && engineProfile ? (
              <div style={{ borderTop: '1px solid var(--fs-line)', paddingTop: 10, marginBottom: 8 }}>
                <div className="fs-section-title">
                  {selectedEngine === 'siliconflow' ? 'SiliconFlow 配置' : 'OpenAI 兼容配置'}
                </div>
                <input
                  className="fs-input"
                  type="password"
                  placeholder="API Key"
                  value={engineProfile.key}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      translation: { ...c.translation, [selectedEngine]: { ...engineProfile, key: e.target.value } },
                    }))
                  }
                  style={{ marginBottom: 6 }}
                />
                <input
                  className="fs-input"
                  placeholder="Base URL"
                  value={engineProfile.baseUrl}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      translation: { ...c.translation, [selectedEngine]: { ...engineProfile, baseUrl: e.target.value } },
                    }))
                  }
                  style={{ marginBottom: 6 }}
                />
                <input
                  className="fs-input"
                  placeholder="Model"
                  value={engineProfile.model}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      translation: { ...c.translation, [selectedEngine]: { ...engineProfile, model: e.target.value } },
                    }))
                  }
                  style={{ marginBottom: 8 }}
                />
                <button className="fs-btn fs-btn--sm fs-btn--block" onClick={() => void saveEngineConfig()}>
                  保存引擎配置
                </button>
              </div>
            ) : null}

            <textarea
              className="fs-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('placeholder.input', {}, locale)}
            />
            <button
              className="fs-btn fs-btn--primary fs-btn--block"
              style={{ marginTop: 8 }}
              onClick={() => void onTranslate()}
              disabled={busy}
            >
              {busy ? t('status.translating', {}, locale) : '翻译'}
            </button>
          </div>

          {result ? (
            <div className="fs-card">
              <div className="fs-section-title">译文</div>
              <pre className={`fs-result${result.startsWith('错误') ? '' : ' fs-result--primary'}`}>{result}</pre>
              <div className="fs-result-actions">
                <button className="fs-btn fs-btn--ghost" onClick={() => readAloud(result)}>
                  🔊 朗读
                </button>
                <button className="fs-btn fs-btn--ghost" onClick={() => void copyText(result)}>
                  复制
                </button>
                <button
                  className="fs-btn fs-btn--ghost"
                  onClick={() => void onAddVocab(text, result)}
                  disabled={!text.trim() || result.startsWith('错误')}
                >
                  ＋生词
                </button>
              </div>
            </div>
          ) : null}

          <button className="fs-btn fs-btn--block" onClick={() => void apiOpenAiChat()}>
            {t('action.openChat', {}, locale)}
          </button>
        </>
      ) : null}

      {tab === 'history' ? (
        <div className="fs-card fs-card--flush">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--fs-line)' }}>
            <span className="fs-section-title" style={{ margin: 0 }}>
              {t('history.title', {}, locale)}（{history.length}）
            </span>
            {history.length > 0 ? (
              <span style={{ display: 'flex', gap: 2 }}>
                <button className="fs-btn fs-btn--ghost" onClick={onExportMarkdown} title="导出 Markdown 单文件">
                  MD
                </button>
                <button className="fs-btn fs-btn--ghost" onClick={onExportZip} title="导出 ZIP（按日拆分）">
                  ZIP
                </button>
                <button className="fs-btn fs-btn--ghost" onClick={onExportJson} title="导出 JSON">
                  JSON
                </button>
                <button className="fs-btn fs-btn--ghost" onClick={() => void onClearHistory()}>
                  清空
                </button>
              </span>
            ) : null}
          </div>
          {history.length === 0 ? (
            <div className="fs-empty">{t('history.empty', {}, locale)}</div>
          ) : (
            <div className="fs-list">
              {history.slice(0, 50).map((item) => (
                <div
                  key={item.id}
                  className="fs-item"
                  onClick={() => {
                    setText(item.sourceText);
                    setResult(item.translatedText);
                    setTab('translate');
                  }}
                >
                  <div className="fs-item-src">{item.sourceText}</div>
                  <div className="fs-item-dst">{item.translatedText}</div>
                  <div className="fs-item-actions">
                    <button
                      className="fs-btn fs-btn--ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        readAloud(item.translatedText);
                      }}
                    >
                      🔊 朗读
                    </button>
                    <button
                      className="fs-btn fs-btn--ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onAddVocab(item.sourceText, item.translatedText);
                      }}
                    >
                      ＋生词
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === 'vocab' ? (
        <div className="fs-card fs-card--flush">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--fs-line)' }}>
            <span className="fs-section-title" style={{ margin: 0 }}>
              生词本（{vocabulary.length}）
            </span>
            {vocabulary.length > 0 ? (
              <span style={{ display: 'flex', gap: 2 }}>
                <button className="fs-btn fs-btn--ghost" onClick={() => onExportVocab('json')} title="导出 JSON">
                  JSON
                </button>
                <button className="fs-btn fs-btn--ghost" onClick={() => onExportVocab('csv')} title="导出 CSV">
                  CSV
                </button>
                <button className="fs-btn fs-btn--ghost" onClick={() => void onClearVocab()}>
                  清空
                </button>
              </span>
            ) : null}
          </div>
          {vocabulary.length === 0 ? (
            <div className="fs-empty">
              还没有生词。在网页划词后点击浮窗的「＋生词」即可加入；★ 收藏会置顶显示。
            </div>
          ) : (
            <div className="fs-list">
              {sortVocabulary(vocabulary).map((item) => (
                <div
                  key={item.id}
                  className="fs-item"
                  style={{ cursor: 'default', ...(item.favorite ? { background: 'var(--fs-primary-soft)' } : null) }}
                >
                  <div className="fs-item-src" style={{ color: 'var(--fs-ink)', fontWeight: 600 }}>
                    {item.term}
                  </div>
                  <div className="fs-item-dst">{item.translation}</div>
                  <div className="fs-item-meta">{formatTime(item.ts)}</div>
                  <div className="fs-item-actions">
                    <button
                      className="fs-btn fs-btn--ghost"
                      onClick={() => void onToggleFav(item.id)}
                      title={item.favorite ? '取消收藏（取消后置回时间序）' : '收藏（置顶显示）'}
                    >
                      {item.favorite ? '★ 已收藏' : '☆ 收藏'}
                    </button>
                    <button className="fs-btn fs-btn--ghost" onClick={() => readAloud(item.term)}>
                      🔊 原文
                    </button>
                    <button className="fs-btn fs-btn--ghost" onClick={() => readAloud(item.translation)}>
                      🔊 译文
                    </button>
                    <button className="fs-btn fs-btn--ghost" onClick={() => void onRemoveVocab(item.id)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
