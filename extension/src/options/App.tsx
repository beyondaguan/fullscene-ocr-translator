/**
 * Options 配置页面：扩展的独立设置页（通过扩展详情页「扩展选项」打开）。
 *
 * 结构：左侧导航（引擎 / 语言 / 划词 / 全文 / 隐私）+ 右侧分区 + 底部常驻保存条。
 * 所有改动先落在本地 state，点「保存设置」才写入 storage 并通知 background 生效。
 */
import { useCallback, useEffect, useState } from 'react';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../shared/storage';
import { apiUpdateEngineConfig } from '../shared/api';
import { loadLocale, saveLocale, type Locale } from '../shared/i18n';
import type { AppConfig } from '../types/config';

const LANG_OPTIONS = [
  { code: 'auto', name: '自动检测' },
  { code: 'zh', name: '中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'ru', name: 'Русский' },
];

const ENGINE_OPTIONS = [
  { value: 'microsoft', label: '微软翻译（免费，免密钥）' },
  { value: 'siliconflow', label: 'SiliconFlow（推荐）' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'mymemory', label: 'MyMemory' },
  { value: 'ollama', label: 'Ollama（本地）' },
  { value: 'lmstudio', label: 'LM Studio（本地）' },
];

/** 划词结果的展示方式 */
const MODE_OPTIONS = [
  { value: 'tooltip', label: '气泡（浮动小窗，3 秒后消失）' },
  { value: 'bilingual', label: '双语对照（原文下方插译文）' },
  { value: 'translation-only', label: '仅译文' },
  { value: 'inline', label: '原位覆盖（译文覆盖原文）' },
];

/** 划词触发方式 */
const SELECTION_MODE_OPTIONS = [
  { value: 'button', label: '按钮触发（选中后出现「译」按钮）' },
  { value: 'auto', label: '自动翻译（选中即译）' },
  { value: 'off', label: '关闭划词翻译' },
];

/** 划词结果交互模式 */
const PANEL_MODE_OPTIONS = [
  { value: 'panel', label: '完整翻译浮窗（可拖动 · 朗读/记录/生词/复制/送侧栏）' },
  { value: 'light', label: '轻量渲染（按结果展示方式直接渲染到页面）' },
];

/** 全文翻译模式 */
const PAGE_MODE_OPTIONS = [
  { value: 'bilingual', label: '双语对照（保留原文，译文追加在下方）' },
  { value: 'translation-only', label: '仅译文（隐藏原文，只显示译文）' },
];

type NavKey = 'engine' | 'language' | 'selection' | 'page' | 'privacy';

const NAV_ITEMS: Array<{ key: NavKey; label: string; desc: string }> = [
  { key: 'engine', label: '翻译引擎', desc: '选择主引擎与降级链，配置云端 API 密钥。' },
  { key: 'language', label: '语言', desc: '设置默认源语言与目标语言。' },
  { key: 'selection', label: '划词翻译', desc: '控制选中文字后的触发方式与结果呈现。' },
  { key: 'page', label: '全文翻译', desc: '翻译整个页面时的呈现方式。' },
  { key: 'privacy', label: '隐私', desc: '是否允许云端翻译与离线模式。' },
];

export function App() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [locale, setLocaleState] = useState<Locale>('zh-CN');
  const [nav, setNav] = useState<NavKey>('engine');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    void (async () => {
      const [cfg, loc] = await Promise.all([loadConfig(), loadLocale()]);
      setConfig(cfg);
      setLocaleState(loc);
    })();
  }, []);

  const selectedEngine = config.translation.defaultEngine;
  const engineProfile =
    selectedEngine === 'siliconflow'
      ? config.translation.siliconflow
      : selectedEngine === 'openai'
        ? config.translation.openai
        : undefined;

  const patchTranslation = useCallback(<K extends keyof AppConfig['translation']>(key: K, value: AppConfig['translation'][K]) => {
    setConfig((c) => ({ ...c, translation: { ...c.translation, [key]: value } }));
  }, []);

  const patchDisplay = useCallback(<K extends keyof AppConfig['display']>(key: K, value: AppConfig['display'][K]) => {
    setConfig((c) => ({ ...c, display: { ...c.display, [key]: value } }));
  }, []);

  const patchPrivacy = useCallback(<K extends keyof AppConfig['privacy']>(key: K, value: AppConfig['privacy'][K]) => {
    setConfig((c) => ({ ...c, privacy: { ...c.privacy, [key]: value } }));
  }, []);

  const onSave = useCallback(async () => {
    setSaving(true);
    setStatus('');
    try {
      await saveConfig(config);
      await apiUpdateEngineConfig();
      setStatus('已保存，所有页面即时生效');
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }, [config]);

  const onLocaleChange = useCallback(async (value: string) => {
    const loc = value as Locale;
    setLocaleState(loc);
    await saveLocale(loc);
  }, []);

  const activeNav = NAV_ITEMS.find((n) => n.key === nav) ?? NAV_ITEMS[0];

  return (
    <div className="fs-app fs-app--options">
      <div className="fs-header">
        <div className="fs-brand">
          <span className="fs-mark">译</span>
          <div>
            <div className="fs-title">全场景 OCR 翻译 · 设置</div>
            <div className="fs-sub">与软件主体联动的浏览器端翻译扩展</div>
          </div>
        </div>
        <select
          className="fs-select"
          style={{ width: 92 }}
          value={locale}
          onChange={(e) => void onLocaleChange(e.target.value)}
        >
          <option value="zh-CN">中文</option>
          <option value="en">EN</option>
        </select>
      </div>

      <div className="fs-options">
        <nav className="fs-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={`fs-nav-item${nav === item.key ? ' is-active' : ''}`}
              onClick={() => setNav(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <main>
          <h2 className="fs-panel-title">{activeNav.label}</h2>
          <p className="fs-panel-desc">{activeNav.desc}</p>

          {nav === 'engine' ? (
            <div className="fs-card">
              <label className="fs-field">
                <span className="fs-label">主引擎</span>
                <select
                  className="fs-select"
                  value={config.translation.defaultEngine}
                  onChange={(e) => patchTranslation('defaultEngine', e.target.value)}
                >
                  {ENGINE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <span className="fs-hint">
                  主引擎不可用时会按降级链自动切换：微软 → MyMemory → SiliconFlow → OpenAI。
                </span>
              </label>

              {engineProfile ? (
                <div style={{ borderTop: '1px solid var(--fs-line)', paddingTop: 10, marginTop: 2 }}>
                  <div className="fs-section-title">
                    {selectedEngine === 'siliconflow' ? 'SiliconFlow 配置' : 'OpenAI 兼容配置'}
                  </div>
                  <label className="fs-field">
                    <span className="fs-label">API Key</span>
                    <input
                      className="fs-input"
                      type="password"
                      placeholder="sk-..."
                      value={engineProfile.key}
                      onChange={(e) =>
                        patchTranslation(selectedEngine as 'siliconflow' | 'openai', {
                          ...engineProfile,
                          key: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="fs-field">
                    <span className="fs-label">Base URL</span>
                    <input
                      className="fs-input"
                      value={engineProfile.baseUrl}
                      onChange={(e) =>
                        patchTranslation(selectedEngine as 'siliconflow' | 'openai', {
                          ...engineProfile,
                          baseUrl: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="fs-field">
                    <span className="fs-label">Model</span>
                    <input
                      className="fs-input"
                      value={engineProfile.model}
                      onChange={(e) =>
                        patchTranslation(selectedEngine as 'siliconflow' | 'openai', {
                          ...engineProfile,
                          model: e.target.value,
                        })
                      }
                    />
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}

          {nav === 'language' ? (
            <div className="fs-card">
              <div className="fs-row">
                <label className="fs-field">
                  <span className="fs-label">源语言</span>
                  <select
                    className="fs-select"
                    value={config.translation.sourceLang}
                    onChange={(e) => patchTranslation('sourceLang', e.target.value)}
                  >
                    {LANG_OPTIONS.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="fs-field">
                  <span className="fs-label">目标语言</span>
                  <select
                    className="fs-select"
                    value={config.translation.targetLang}
                    onChange={(e) => patchTranslation('targetLang', e.target.value)}
                  >
                    {LANG_OPTIONS.filter((o) => o.code !== 'auto').map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="fs-hint">目标语言同时决定朗读（TTS）使用的语音。</p>
            </div>
          ) : null}

          {nav === 'selection' ? (
            <>
              <div className="fs-card">
                <label className="fs-field">
                  <span className="fs-label">触发方式</span>
                  <select
                    className="fs-select"
                    value={config.display.selectionMode}
                    onChange={(e) => patchDisplay('selectionMode', e.target.value as AppConfig['display']['selectionMode'])}
                  >
                    {SELECTION_MODE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span className="fs-hint">
                    默认「按钮触发」：选中文本后出现「译」按钮，点击才翻译，避免误触发。
                  </span>
                </label>
                <label className="fs-field">
                  <span className="fs-label">结果交互模式</span>
                  <select
                    className="fs-select"
                    value={config.display.panelMode}
                    onChange={(e) => patchDisplay('panelMode', e.target.value as AppConfig['display']['panelMode'])}
                  >
                    {PANEL_MODE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span className="fs-hint">
                    完整浮窗带标题栏（可拖动）与底部操作条：朗读 / 记录 / ＋生词 / 复制 / 送侧栏。
                  </span>
                </label>
                <label className="fs-field">
                  <span className="fs-label">结果展示方式</span>
                  <select
                    className="fs-select"
                    value={config.display.mode}
                    onChange={(e) => patchDisplay('mode', e.target.value as AppConfig['display']['mode'])}
                  >
                    {MODE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span className="fs-hint">仅在「轻量渲染」模式下生效（完整浮窗忽略此项）。</span>
                </label>
              </div>

              <div className="fs-card">
                <div className="fs-section-title">实时与高亮</div>
                <label className="fs-switch">
                  <input
                    type="checkbox"
                    checked={config.display.realtime}
                    onChange={(e) => patchDisplay('realtime', e.target.checked)}
                  />
                  <span className="fs-switch-text">
                    <span className="fs-switch-name">实时翻译（悬停即译）</span>
                    <span className="fs-switch-desc">
                      鼠标悬停在段落上约 0.25 秒即自动翻译，无需选中。开启后会频繁请求引擎，建议按需开启。
                    </span>
                  </span>
                </label>
                <label className="fs-switch">
                  <input
                    type="checkbox"
                    checked={config.display.highlight}
                    onChange={(e) => patchDisplay('highlight', e.target.checked)}
                  />
                  <span className="fs-switch-text">
                    <span className="fs-switch-name">高亮已翻译的原文</span>
                    <span className="fs-switch-desc">为划词翻译过的选区加底色标记，便于回顾。</span>
                  </span>
                </label>
              </div>
            </>
          ) : null}

          {nav === 'page' ? (
            <div className="fs-card">
              <label className="fs-field">
                <span className="fs-label">全文翻译呈现方式</span>
                <select
                  className="fs-select"
                  value={config.display.pageMode}
                  onChange={(e) => patchDisplay('pageMode', e.target.value as AppConfig['display']['pageMode'])}
                >
                  {PAGE_MODE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <span className="fs-hint">
                  通过弹窗「翻译本页」或快捷键触发；随时可用「还原原文」恢复页面。
                </span>
              </label>
            </div>
          ) : null}

          {nav === 'privacy' ? (
            <div className="fs-card">
              <label className="fs-switch">
                <input
                  type="checkbox"
                  checked={config.privacy.allowCloud}
                  onChange={(e) => patchPrivacy('allowCloud', e.target.checked)}
                />
                <span className="fs-switch-text">
                  <span className="fs-switch-name">允许云端翻译</span>
                  <span className="fs-switch-desc">关闭后仅使用本地引擎（Ollama / LM Studio）。</span>
                </span>
              </label>
              <label className="fs-switch">
                <input
                  type="checkbox"
                  checked={config.privacy.localOnly}
                  onChange={(e) => patchPrivacy('localOnly', e.target.checked)}
                />
                <span className="fs-switch-text">
                  <span className="fs-switch-name">仅本地（完全离线）</span>
                  <span className="fs-switch-desc">强制走本地引擎，任何文本都不会离开本机。</span>
                </span>
              </label>
            </div>
          ) : null}
        </main>
      </div>

      <div className="fs-savebar">
        {status ? (
          <span className={`fs-status ${status.startsWith('保存失败') ? 'fs-status--err' : 'fs-status--ok'}`}>
            {status}
          </span>
        ) : null}
        <button className="fs-btn fs-btn--ghost" onClick={() => void setConfig(DEFAULT_CONFIG)}>
          恢复默认
        </button>
        <button className="fs-btn fs-btn--primary" onClick={() => void onSave()} disabled={saving}>
          {saving ? '保存中…' : '保存设置'}
        </button>
      </div>
    </div>
  );
}
