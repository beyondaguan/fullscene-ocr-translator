import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Select, type SelectOption } from '../components/Select';
import { Switch } from '../components/Switch';
import { Tabs } from '../components/Tabs';
import type { EngineInfo } from '../hooks/useNativeMsg';
import {
  ACCENTS,
  DEFAULT_ACCENT,
  DEFAULT_FONT,
  DEFAULT_FONT_SCALE,
  FONT_FAMILIES,
  FONT_SCALES,
} from '../theme';

export interface SettingsData {
  ocr_model_dir?: string | null;
  llm_endpoint?: string | null;
  llm_model?: string | null;
  /** 全局动作热键表：动作 id → 组合键（与 Rust `Config.hotkeys` 对齐）。清空某动作 = 恢复代码内置默认键 */
  hotkeys?: Record<string, string> | null;
  ui_theme?: string | null;
  /** 界面字体族 id（字体栈见 `theme.ts` FONT_FAMILIES） */
  ui_font?: string | null;
  /** 界面字号缩放百分比（80-160） */
  ui_font_scale?: number | null;
  /** 主题色板 id（色值见 `theme.ts` ACCENTS） */
  ui_accent?: string | null;
  /** 翻译轴配置（降级链 + 各云引擎密钥），与 Rust `TranslateConfig` 对齐 */
  translate?: TranslateSettings;
}

export interface TranslateSettings {
  fallback_order?: string[];
  siliconflow_key?: string | null;
  siliconflow_base_url?: string | null;
  siliconflow_model?: string | null;
  openai_key?: string | null;
  openai_base_url?: string | null;
  openai_model?: string | null;
  edge_key?: string | null;
  edge_region?: string | null;
  bing_key?: string | null;
  bing_region?: string | null;
}

export interface SettingsProps {
  initial?: SettingsData;
  configPath?: string;
  theme?: 'light' | 'dark';
  /** 已注册引擎及可用状态（来自 Rust `list_engines`） */
  engines?: EngineInfo[];
  onThemeChange?: (theme: 'light' | 'dark') => void;
  /** 强调色变更（即时生效，宿主同步写回 Rust 配置） */
  onAccentChange?: (id: string) => void;
  /** 字体族变更（即时生效，宿主同步写回 Rust 配置） */
  onFontChange?: (id: string) => void;
  /** 界面字号缩放变更（80-160） */
  onFontScaleChange?: (scale: number) => void;
  /** 宿主持有的当前值，用于渲染选中态 */
  accentId?: string;
  fontId?: string;
  fontScale?: number;
  onSave?: (cfg: SettingsData) => Promise<void> | void;
  onReload?: () => void;
  onTestConnection?: (endpoint: string, model: string) => Promise<string>;
  /** 热键录入态变化：true 时宿主应挂起全局热键，false 时恢复 */
  onHotkeyCapture?: (listening: boolean) => void;
  /** 指定引擎试译（设置页「测试」按钮），返回译文或抛错 */
  onTestEngine?: (id: string) => Promise<string>;
}

type Category = 'general' | 'ocr' | 'translate' | 'ai' | 'hotkey' | 'about';

const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'ocr', label: 'OCR' },
  { key: 'translate', label: '翻译' },
  { key: 'ai', label: 'AI' },
  { key: 'hotkey', label: '快捷键' },
  { key: 'about', label: '关于' },
];

const IN_APP_HOTKEYS: [string, string][] = [
  ['Alt+3', 'AI 助手抽屉'],
  ['Alt+4', '翻译历史抽屉'],
  ['Alt+5', '设置抽屉'],
  ['Ctrl+V', '从剪贴板读取文本'],
  ['Alt+C', '复制译文'],
  ['Alt+V', '朗读译文'],
  ['Alt+X', '交换源语言与目标语言'],
  ['Alt+Backspace', '清空画布'],
  ['Esc', '关闭当前抽屉'],
];

/**
 * 全局动作热键：动作 id → [中文标签, 代码内置默认键]。与 Rust `config::DEFAULT_HOTKEYS` 同步。
 *
 * 这些键走 `RegisterHotKey`，**窗口内、窗口外都会触发**——所以前端不再重复注册，
 * 否则一次按键命中两条路径会触发两次。
 */
const GLOBAL_HOTKEY_ACTIONS: [string, string, string][] = [
  ['selection_translate', '十字框选截图翻译（主入口，窗口内外通用）', 'Alt+Q'],
  ['fullscreen_translate', '整屏即时翻译（无框选）', 'Ctrl+Alt+O'],
];

const hairline = '0.5px solid var(--color-hairline)';

/** 设置：抽屉内渲染，分类横向排列 + 内容纵向滚动。 */
export function Settings({
  initial,
  configPath,
  theme = 'light',
  engines,
  onThemeChange,
  onAccentChange,
  onFontChange,
  onFontScaleChange,
  accentId,
  fontId,
  fontScale,
  onSave,
  onReload,
  onTestConnection,
  onTestEngine,
  onHotkeyCapture,
}: SettingsProps) {
  const [cat, setCat] = useState<Category>('general');
  const [cfg, setCfg] = useState<SettingsData>(initial ?? {});

  useEffect(() => {
    if (initial) setCfg(initial);
  }, [initial]);

  const set = (patch: Partial<SettingsData>) => setCfg((c) => ({ ...c, ...patch }));

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 'none', padding: '10px var(--spacing-lg)', borderBottom: hairline, overflowX: 'auto' }}>
        <Tabs items={CATEGORIES} activeKey={cat} onChange={(k) => setCat(k)} />
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 'var(--spacing-lg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-md)',
        }}
      >
        {cat === 'general' && (
          <AppearancePane
            theme={theme}
            onThemeChange={(next) => {
              onThemeChange?.(next);
              set({ ui_theme: next });
            }}
            accentId={accentId ?? cfg.ui_accent ?? DEFAULT_ACCENT}
            onAccentChange={(id) => {
              onAccentChange?.(id);
              set({ ui_accent: id });
            }}
            fontId={fontId ?? cfg.ui_font ?? DEFAULT_FONT}
            onFontChange={(id) => {
              onFontChange?.(id);
              set({ ui_font: id });
            }}
            fontScale={fontScale ?? cfg.ui_font_scale ?? DEFAULT_FONT_SCALE}
            onFontScaleChange={(n) => {
              onFontScaleChange?.(n);
              set({ ui_font_scale: n });
            }}
          />
        )}

        {cat === 'ocr' && (
          <Input
            label="OCR 模型目录（留空用默认）"
            value={cfg.ocr_model_dir ?? ''}
            onChange={(e) => set({ ocr_model_dir: e.target.value || null })}
          />
        )}

        {cat === 'translate' && (
          <TranslatePane
            engines={engines}
            value={cfg.translate ?? {}}
            llmEndpoint={cfg.llm_endpoint ?? ''}
            llmModel={cfg.llm_model ?? ''}
            onChange={(patch) => set({ translate: { ...(cfg.translate ?? {}), ...patch } })}
            onLlmChange={(patch) => set(patch)}
            onTestEngine={onTestEngine}
            onTestConnection={onTestConnection}
          />
        )}

        {cat === 'ai' && (
          <>
            <Input
              label="AI 对话默认端点"
              value={cfg.llm_endpoint ?? ''}
              onChange={(e) => set({ llm_endpoint: e.target.value || null })}
            />
            <Input
              label="AI 对话默认模型"
              value={cfg.llm_model ?? ''}
              onChange={(e) => set({ llm_model: e.target.value || null })}
            />
          </>
        )}

        {cat === 'hotkey' && (
          <>
            <div style={sectionTitle}>全局动作热键（点「录入」后按下组合键）</div>
            <div style={sectionHint}>
              这些键走系统级全局热键，**窗口有焦点时同样生效**，所以「窗口内 / 窗口外」是同一个键。
              点「录入」后直接按组合键即可（录入期间其它热键会临时停用）；支持 Alt/Ctrl/Shift + 字母、数字或 F1~F24。
              清空即恢复默认键。改完需点「应用并保存」。
            </div>
            {GLOBAL_HOTKEY_ACTIONS.map(([id, label, def]) => (
              <HotkeyRecorder
                key={id}
                actionId={id}
                label={label}
                defaultValue={def}
                value={cfg.hotkeys?.[id] ?? null}
                onChange={(v) => {
                  const next = { ...(cfg.hotkeys ?? {}) };
                  if (v == null) delete next[id];
                  else next[id] = v;
                  set({ hotkeys: next });
                }}
                onCaptureChange={onHotkeyCapture}
              />
            ))}
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                应用内快捷键（固定，不可改）
              </div>
              {IN_APP_HOTKEYS.map(([k, label]) => (
                <div
                  key={k}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--spacing-sm)',
                    padding: '5px 0',
                    fontSize: 'var(--font-size-sm)',
                  }}
                >
                  <kbd
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--font-size-xs)',
                      border: hairline,
                      borderRadius: 'var(--radius-sm)',
                      padding: '1px 6px',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    {k}
                  </kbd>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {cat === 'about' && (
          <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.9, color: 'var(--color-text-secondary)' }}>
            <p>全场景OCR翻译系统 v1.8.0</p>
            <p>配置文件：{configPath || '未加载'}</p>
            <p>架构：Rust + Tauri 2（tao / wry / WebView2）+ React 单画布</p>
            <p>界面：单画布 + 右侧抽屉，无页面跳转</p>
          </div>
        )}
      </div>

      <div
        style={{
          flex: 'none',
          padding: 'var(--spacing-md) var(--spacing-lg)',
          borderTop: hairline,
          display: 'flex',
          gap: 'var(--spacing-sm)',
        }}
      >
        <Button variant="primary" onClick={() => onSave?.(cfg)}>
          应用并保存
        </Button>
        <Button onClick={onReload}>重新加载配置</Button>
      </div>
    </div>
  );
}

const DEFAULT_ORDER = ['mymemory', 'google', 'local-llm'];

interface HotkeyRecorderProps {
  actionId: string;
  label: string;
  defaultValue: string;
  value: string | null;
  onChange: (v: string | null) => void;
  /** 进入/退出录入态时通知宿主：宿主需挂起/恢复全局热键，否则按键会被抢走 */
  onCaptureChange?: (listening: boolean) => void;
}

/**
 * 物理键位（`KeyboardEvent.code`）→ 组合串里的主键名。
 * 与 Rust `hotkey::parse_combo` 接受的范围保持一致：字母 / 数字 / F1~F24。
 */
function codeToMainKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return null;
}

/** 单个全局动作的热键录入控件：点击「录入」进入监听态，按下组合键即捕获（需至少含一个修饰键），Esc 取消，可清空恢复默认。 */
function HotkeyRecorder({
  actionId,
  label,
  defaultValue,
  value,
  onChange,
  onCaptureChange,
}: HotkeyRecorderProps) {
  const [listening, setListening] = useState(false);

  // 两个回调都用 ref 持有：父层传的是内联箭头函数，直接进 effect 依赖数组会让
  // effect 每次 render 重跑 —— 表现为全局热键「挂起→恢复」反复抖动。
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCaptureRef = useRef(onCaptureChange);
  onCaptureRef.current = onCaptureChange;

  useEffect(() => {
    if (!listening) return;
    // 挂起全局热键：否则按下 Alt+Q 的瞬间，Rust 侧先弹出框选遮罩把焦点抢走，
    // 这次按键根本到不了下面的 keydown。
    onCaptureRef.current?.(true);
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === 'Escape') {
        setListening(false);
        return;
      }
      // 用 `e.code`（物理键位）而不是 `e.key`：`e.key` 在 Alt 组合下会被系统改写
      // （某些布局 Alt+Q 报的是 '@'），录出来的串与 Rust 侧解析不出同一个键。
      const main = codeToMainKey(e.code);
      if (!main) return; // 忽略 Shift/Ctrl/Alt/Win 自身的 keydown 与不支持的主键
      const parts: string[] = [];
      if (e.altKey) parts.push('Alt');
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.shiftKey) parts.push('Shift');
      if (e.metaKey) parts.push('Win');
      // 必须至少含一个修饰键，避免无修饰的字母键劫持全局输入
      if (parts.length === 0) return;
      parts.push(main);
      onChangeRef.current(parts.join('+'));
      setListening(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      onCaptureRef.current?.(false);
    };
  }, [listening]);

  const display = value ?? `默认 ${defaultValue}`;

  return (
    <div
      data-action={actionId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-sm)',
        padding: '6px 0',
        fontSize: 'var(--font-size-sm)',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, color: 'var(--color-text-secondary)' }}>{label}</span>
      <kbd
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--font-size-xs)',
          border: hairline,
          borderRadius: 'var(--radius-sm)',
          padding: '1px 6px',
          color: listening ? 'var(--color-accent)' : 'var(--color-text-secondary)',
          minWidth: 64,
          textAlign: 'center',
        }}
      >
        {listening ? '按下…' : display}
      </kbd>
      {!listening && (
        <Button size="sm" onClick={() => setListening(true)}>
          录入
        </Button>
      )}
      {value && (
        <Button size="sm" variant="text" onClick={() => onChange(null)}>
          清除
        </Button>
      )}
    </div>
  );
}

interface TranslatePaneProps {
  engines?: EngineInfo[];
  value: TranslateSettings;
  llmEndpoint: string;
  llmModel: string;
  onChange: (patch: Partial<TranslateSettings>) => void;
  onLlmChange: (patch: Partial<SettingsData>) => void;
  onTestEngine?: (id: string) => Promise<string>;
  onTestConnection?: (endpoint: string, model: string) => Promise<string>;
}

const sectionTitle: CSSProperties = {
  fontSize: 'var(--font-size-sm)',
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  margin: 'var(--spacing-sm) 0 2px',
};

const sectionHint: CSSProperties = {
  fontSize: 'var(--font-size-xs)',
  color: 'var(--color-text-tertiary)',
  marginBottom: 'var(--spacing-xs)',
};

/**
 * 硅基流动常用模型（2026-10 核实：以下 4 个输入输出均为 ¥0 免费档）。
 *
 * 为什么必须下拉而不是自由文本：引擎代码的**默认模型是 `deepseek-ai/DeepSeek-V3`（付费，
 * ¥2/¥8 每百万 token）**。手输模型名一旦拼错或沿用默认值，就会产生真金白银的账单，
 * 而界面上没有任何提示。下拉 + 免费/付费标识把成本暴露在选择那一刻。
 */
const SILICONFLOW_MODELS: SelectOption[] = [
  { value: 'tencent/Hunyuan-MT-7B', label: 'Hunyuan-MT-7B（免费·翻译专用·33 语种）' },
  { value: 'deepseek-ai/DeepSeek-OCR', label: 'DeepSeek-OCR（免费·视觉 OCR）' },
  { value: 'THUDM/GLM-Z1-9B-0414', label: 'GLM-Z1-9B-0414（免费·推理·128K）' },
  { value: 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B', label: 'DeepSeek-R1-0528-Qwen3-8B（免费·推理·128K）' },
  { value: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek-V3（付费 ¥2/¥8 每百万 token）' },
];

const badge = (ok: boolean): CSSProperties => ({
  fontSize: 'var(--font-size-xs)',
  padding: '1px 8px',
  borderRadius: 999,
  border: hairline,
  color: ok ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
  flex: 'none',
});

/** 翻译页：引擎状态 + 降级链排序 + 各引擎密钥。 */
function AppearancePane(props: {
  theme: 'light' | 'dark';
  onThemeChange: (t: 'light' | 'dark') => void;
  accentId: string;
  onAccentChange: (id: string) => void;
  fontId: string;
  onFontChange: (id: string) => void;
  fontScale: number;
  onFontScaleChange: (n: number) => void;
}) {
  const { theme, onThemeChange, accentId, onAccentChange, fontId, onFontChange, fontScale, onFontScaleChange } = props;
  return (
    <>
      <Switch
        checked={theme === 'light'}
        onChange={(v) => onThemeChange(v ? 'light' : 'dark')}
        label="浅色主题（关闭 = 深色）"
      />

      <div style={sectionTitle}>主题色</div>
      <div style={sectionHint}>用于按钮、选中态与强调文字。切换即时生效。</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
        {ACCENTS.map((a) => {
          const active = a.id === accentId;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onAccentChange(a.id)}
              title={a.label}
              aria-label={a.label}
              aria-pressed={active}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--spacing-xs)',
                padding: '6px 10px',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                // 选中态用 0.5px 发丝线 + 强调色描边，不用厚边框贴纸（见设计规范）
                border: `0.5px solid ${active ? a.base : 'var(--color-hairline-strong)'}`,
                background: active ? a.soft : 'transparent',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: a.base,
                  flex: '0 0 auto',
                }}
              />
              {a.label}
            </button>
          );
        })}
      </div>

      <div style={sectionTitle}>界面字体</div>
      <div style={sectionHint}>全部使用 Windows 自带字体，无需额外安装。切换即时生效。</div>
      <Select
        value={fontId}
        onChange={(v) => onFontChange(v)}
        ariaLabel="界面字体"
        options={FONT_FAMILIES.map((f) => ({ value: f.id, label: f.label }))}
      />

      <div style={sectionTitle}>界面字号</div>
      <div style={sectionHint}>整体等比缩放，含状态栏与两栏文本区。</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
        {FONT_SCALES.map((n) => {
          const active = n === fontScale;
          return (
            <button
              key={n}
              type="button"
              onClick={() => onFontScaleChange(n)}
              aria-pressed={active}
              style={{
                minWidth: 56,
                padding: '6px 8px',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                border: `0.5px solid ${active ? 'var(--color-primary)' : 'var(--color-hairline-strong)'}`,
                background: active ? 'var(--color-accent-soft)' : 'transparent',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-size-sm)',
                fontFamily: 'var(--font-family)',
              }}
            >
              {n}%
            </button>
          );
        })}
      </div>
    </>
  );
}

function TranslatePane({
  engines,
  value,
  llmEndpoint,
  llmModel,
  onChange,
  onLlmChange,
  onTestEngine,
  onTestConnection,
}: TranslatePaneProps) {
  const order = value.fallback_order?.length ? value.fallback_order : DEFAULT_ORDER;
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const dragFrom = useRef<number | null>(null);

  const setOrder = (next: string[]) => onChange({ fallback_order: next });

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setOrder(next);
  };

  const doTest = async (id: string) => {
    if (!onTestEngine) return;
    setTesting(id);
    try {
      const t = await onTestEngine(id);
      setResults((r) => ({ ...r, [id]: `✓ ${t.slice(0, 60)}` }));
    } catch (e) {
      setResults((r) => ({ ...r, [id]: `✗ ${String(e).slice(0, 120)}` }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <>
      <div style={sectionTitle}>降级链（拖拽或用 ↑↓ 调整；排前的优先使用）</div>
      <div style={sectionHint}>
        翻译时按此顺序尝试，跳过未配置密钥的引擎；某引擎失败自动切下一个。
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 'var(--spacing-sm)' }}>
        {order.map((id, i) => {
          const info = engines?.find((e) => e.id === id);
          return (
            <div
              key={id}
              draggable
              onDragStart={() => (dragFrom.current = i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom.current !== null) move(dragFrom.current, i);
                dragFrom.current = null;
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--spacing-sm)',
                padding: '6px 10px',
                border: hairline,
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--font-size-sm)',
                background: 'var(--color-bg-hover)',
                cursor: 'grab',
              }}
            >
              <span style={{ color: 'var(--color-text-tertiary)', width: 14, flex: 'none' }}>{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {info?.label ?? id}
                <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 6, fontSize: 'var(--font-size-xs)' }}>
                  {info ? (info.available ? '已就绪' : '未配置') : ''}
                </span>
              </span>
              <Button size="sm" aria-label={`上移 ${id}`} onClick={() => move(i, i - 1)} disabled={i === 0}>
                ↑
              </Button>
              <Button
                size="sm"
                aria-label={`下移 ${id}`}
                onClick={() => move(i, i + 1)}
                disabled={i === order.length - 1}
              >
                ↓
              </Button>
            </div>
          );
        })}
      </div>

      <div style={sectionTitle}>引擎状态</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 'var(--spacing-sm)' }}>
        {(engines ?? []).map((e) => (
          <div
            key={e.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--spacing-sm)',
              padding: '5px 10px',
              border: hairline,
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              {e.label}
              <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 6, fontSize: 'var(--font-size-xs)' }}>
                {e.id}
              </span>
            </span>
            <span style={badge(e.available)}>{e.available ? '已就绪' : '未配置'}</span>
            {onTestEngine && (
              <Button size="sm" onClick={() => doTest(e.id)} disabled={testing !== null}>
                {testing === e.id ? '测试中…' : '测试'}
              </Button>
            )}
          </div>
        ))}
        {Object.entries(results).map(([id, r]) =>
          r ? (
            <div key={id} style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', padding: '0 10px' }}>
              {id}: {r}
            </div>
          ) : null,
        )}
      </div>

      <div style={sectionTitle}>引擎密钥与参数</div>
      <div style={sectionHint}>保存后立即生效（注册表热重建），无需重启。</div>
      <Input
        label="SiliconFlow API Key（sk-…）"
        value={value.siliconflow_key ?? ''}
        onChange={(e) => onChange({ siliconflow_key: e.target.value || null })}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={sectionHint}>SiliconFlow 模型（★ = 免费档，输入输出 ¥0）</span>
        <Select
          ariaLabel="SiliconFlow 模型"
          value={value.siliconflow_model || 'tencent/Hunyuan-MT-7B'}
          options={SILICONFLOW_MODELS.map((m) => ({
            ...m,
            label: m.label.startsWith('DeepSeek-OCR') || m.label.includes('Hunyuan') || m.label.includes('GLM') || m.label.includes('R1-0528')
              ? `★ ${m.label}`
              : m.label,
          }))}
          onChange={(v) => onChange({ siliconflow_model: v })}
        />
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
          翻译场景请选 ★ Hunyuan-MT-7B：WMT2025 冠军、33 语种、免费，且比通用大模型更不会「解释一堆」。
        </span>
      </div>
      <Input
        label="SiliconFlow Base URL（默认官方）"
        value={value.siliconflow_base_url ?? ''}
        onChange={(e) => onChange({ siliconflow_base_url: e.target.value || null })}
      />
      <Input
        label="OpenAI API Key"
        value={value.openai_key ?? ''}
        onChange={(e) => onChange({ openai_key: e.target.value || null })}
      />
      <Input
        label="OpenAI 模型（默认 gpt-4o-mini）"
        value={value.openai_model ?? ''}
        onChange={(e) => onChange({ openai_model: e.target.value || null })}
      />
      <Input
        label="OpenAI Base URL（可指向任意兼容网关）"
        value={value.openai_base_url ?? ''}
        onChange={(e) => onChange({ openai_base_url: e.target.value || null })}
      />
      <Input
        label="Microsoft Edge/Azure 订阅密钥"
        value={value.edge_key ?? ''}
        onChange={(e) => onChange({ edge_key: e.target.value || null })}
      />
      <Input
        label="Edge/Azure 区域（如 eastasia）"
        value={value.edge_region ?? ''}
        onChange={(e) => onChange({ edge_region: e.target.value || null })}
      />
      <Input
        label="Bing 翻译订阅密钥"
        value={value.bing_key ?? ''}
        onChange={(e) => onChange({ bing_key: e.target.value || null })}
      />
      <Input
        label="Bing 翻译区域"
        value={value.bing_region ?? ''}
        onChange={(e) => onChange({ bing_region: e.target.value || null })}
      />
      <Input
        label="本地大模型端点（Ollama 默认 http://127.0.0.1:11434）"
        value={llmEndpoint}
        onChange={(e) => onLlmChange({ llm_endpoint: e.target.value || null })}
      />
      <Input
        label="本地大模型名（默认 qwen2.5）"
        value={llmModel}
        onChange={(e) => onLlmChange({ llm_model: e.target.value || null })}
      />
      <LocalLlmTest
        llmEndpoint={llmEndpoint}
        llmModel={llmModel}
        onTestConnection={onTestConnection}
      />
    </>
  );
}

/** 本地 LLM 连接测试（独立小组件，保持测试状态局部化）。 */
function LocalLlmTest({
  llmEndpoint,
  llmModel,
  onTestConnection,
}: {
  llmEndpoint: string;
  llmModel: string;
  onTestConnection?: (endpoint: string, model: string) => Promise<string>;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState('');
  return (
    <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center' }}>
      <Button
        size="sm"
        disabled={testing}
        onClick={async () => {
          if (!onTestConnection) return;
          setTesting(true);
          try {
            setResult(await onTestConnection(llmEndpoint, llmModel));
          } catch (e) {
            setResult(`连接失败: ${String(e)}`);
          } finally {
            setTesting(false);
          }
        }}
      >
        {testing ? '测试中…' : '测试连接'}
      </Button>
      {result && (
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{result}</span>
      )}
    </div>
  );
}
