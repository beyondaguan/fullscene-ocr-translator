/**
 * Popup 主界面：快速翻译 / 截图翻译 / 框选翻译 / 翻译本页·还原 / 打开侧栏。
 * 语言与引擎下拉即改即存；引擎 API 配置折叠在「配置」内。
 */
import { useCallback, useEffect, useState } from 'react';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../shared/storage';
import {
  apiTranslate,
  apiCaptureTranslate,
  apiSelectCaptureTranslate,
  apiTranslatePage,
  apiRestorePage,
  apiUpdateEngineConfig,
} from '../shared/api';
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

export function App() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [text, setText] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [locale, setLocaleState] = useState<Locale>('zh-CN');
  const [showEngineConfig, setShowEngineConfig] = useState(false);

  useEffect(() => {
    void (async () => {
      const [cfg, loc] = await Promise.all([loadConfig(), loadLocale()]);
      setConfig(cfg);
      setLocaleState(loc);
    })();
  }, []);

  const updateConfig = useCallback(
    async (patch: Partial<AppConfig>) => {
      const next = { ...config, ...patch };
      setConfig(next);
      await saveConfig(next);
    },
    [config],
  );

  const onTranslate = useCallback(async () => {
    const input = text.trim();
    if (!input || busy) return;
    setBusy(true);
    setStatus('');
    try {
      const resp = await apiTranslate({
        text: input,
        sourceLang: config.translation.sourceLang,
        targetLang: config.translation.targetLang,
        engine: config.translation.defaultEngine,
      });
      setResult(resp.text);
    } catch (error) {
      setStatus(`${t('status.error', {}, locale)}：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [text, busy, config, locale]);

  const onCapture = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus('截图中…');
    try {
      const resp = await apiCaptureTranslate({ target: { mode: 'Primary' }, dst: config.translation.targetLang });
      setResult(resp.translation ? `【原文】\n${resp.ocrText}\n\n【译文】\n${resp.translation}` : t('status.noText', {}, locale));
      setStatus('');
    } catch (error) {
      setStatus(`${t('status.error', {}, locale)}：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, config.translation.targetLang, locale]);

  const onSelectCapture = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus('框选中，请在屏幕上拖出区域…');
    try {
      const resp = await apiSelectCaptureTranslate(config.translation.targetLang);
      setResult(resp.translation ? `【原文】\n${resp.ocrText}\n\n【译文】\n${resp.translation}` : t('status.noText', {}, locale));
      setStatus('');
    } catch (error) {
      setStatus(`${t('status.error', {}, locale)}：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, config.translation.targetLang, locale]);

  const onTranslatePage = useCallback(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await apiTranslatePage(tab.id);
      setStatus('全文翻译完成，可点「还原原文」恢复');
    } catch (error) {
      setStatus(`${t('status.error', {}, locale)}：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [locale]);

  const onRestorePage = useCallback(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await apiRestorePage(tab.id);
      setStatus('已还原原文');
    } catch (error) {
      setStatus(`${t('status.error', {}, locale)}：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [locale]);

  const onOpenSidebar = useCallback(() => {
    void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(() => undefined);
  }, []);

  const onLocaleChange = useCallback(async (value: string) => {
    const loc = value as Locale;
    setLocaleState(loc);
    await saveLocale(loc);
  }, []);

  const saveEngineConfig = useCallback(async () => {
    await saveConfig(config);
    await apiUpdateEngineConfig();
    setShowEngineConfig(false);
    setStatus('引擎配置已保存');
  }, [config]);

  const selectedEngine = config.translation.defaultEngine;
  const engineProfile =
    selectedEngine === 'siliconflow'
      ? config.translation.siliconflow
      : selectedEngine === 'openai'
        ? config.translation.openai
        : undefined;

  return (
    <div className="fs-app fs-app--popup">
      <div className="fs-header">
        <div className="fs-brand">
          <span className="fs-mark">译</span>
          <div>
            <div className="fs-title">{t('app.title', {}, locale)}</div>
            <div className="fs-sub">划词 · 全文 · 截图</div>
          </div>
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select
            className="fs-select"
            style={{ width: 72 }}
            value={locale}
            onChange={(e) => void onLocaleChange(e.target.value)}
          >
            <option value="zh-CN">中文</option>
            <option value="en">EN</option>
          </select>
          <button
            className="fs-btn fs-btn--ghost"
            onClick={() => void chrome.runtime.openOptionsPage()}
            title="打开完整设置页"
          >
            设置
          </button>
        </span>
      </div>

      <div className="fs-card">
        <div className="fs-row" style={{ marginBottom: 6 }}>
          <select
            className="fs-select"
            value={config.translation.sourceLang}
            onChange={(e) => void updateConfig({ translation: { ...config.translation, sourceLang: e.target.value } })}
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
            onChange={(e) => void updateConfig({ translation: { ...config.translation, targetLang: e.target.value } })}
          >
            {LANG_OPTIONS.filter((o) => o.code !== 'auto').map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </select>
        </div>

        <div className="fs-row">
          <select
            className="fs-select"
            value={config.translation.defaultEngine}
            onChange={(e) => void updateConfig({ translation: { ...config.translation, defaultEngine: e.target.value } })}
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
          <div style={{ borderTop: '1px solid var(--fs-line)', paddingTop: 8, marginTop: 8 }}>
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
              style={{ marginBottom: 6 }}
            />
            <button className="fs-btn fs-btn--sm fs-btn--block" onClick={() => void saveEngineConfig()}>
              保存
            </button>
          </div>
        ) : null}
      </div>

      <div className="fs-card">
        <textarea
          className="fs-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('placeholder.input', {}, locale)}
          style={{ minHeight: 64 }}
        />
        <div className="fs-row" style={{ marginTop: 8 }}>
          <button className="fs-btn fs-btn--primary" onClick={() => void onTranslate()} disabled={busy}>
            翻译
          </button>
          <button className="fs-btn" onClick={() => void onCapture()} disabled={busy}>
            {t('action.capture', {}, locale)}
          </button>
          <button className="fs-btn" onClick={() => void onSelectCapture()} disabled={busy}>
            {t('action.selectCapture', {}, locale)}
          </button>
        </div>
      </div>

      <div className="fs-row" style={{ marginBottom: 10 }}>
        <button className="fs-btn fs-btn--sm" onClick={() => void onTranslatePage()}>
          翻译本页
        </button>
        <button className="fs-btn fs-btn--sm" onClick={() => void onRestorePage()}>
          还原原文
        </button>
        <button className="fs-btn fs-btn--sm" onClick={onOpenSidebar}>
          侧栏
        </button>
      </div>

      {status ? (
        <div className="fs-status fs-status--err" style={{ marginBottom: 8 }}>
          {status}
        </div>
      ) : null}

      {result ? (
        <div className="fs-card">
          <pre className="fs-result fs-result--primary">{result}</pre>
          <div className="fs-result-actions">
            <button
              className="fs-btn fs-btn--ghost"
              onClick={() => {
                try {
                  speak(result, { lang: config.translation.targetLang });
                } catch {
                  // 环境不支持语音合成
                }
              }}
            >
              🔊 朗读
            </button>
            <button
              className="fs-btn fs-btn--ghost"
              onClick={() => void navigator.clipboard.writeText(result).catch(() => undefined)}
            >
              复制
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
