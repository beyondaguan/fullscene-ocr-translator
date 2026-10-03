import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_ACCENT,
  DEFAULT_FONT,
  DEFAULT_FONT_SCALE,
  resolveAccent,
  resolveFont,
} from '../theme';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'fullscene-theme';
const STORAGE_ACCENT = 'fullscene-accent';
const STORAGE_FONT = 'fullscene-font';
const STORAGE_SCALE = 'fullscene-font-scale';

function readInitial(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readStr(key: string, allowed: readonly string[], fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = localStorage.getItem(key);
  return v && allowed.includes(v) ? v : fallback;
}

function readScale(fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const raw = localStorage.getItem(STORAGE_SCALE);
  const n = raw ? Number(raw) : NaN;
  // 与 settings.schema.json 的 80–160 一致；越界按 fallback 处理
  return Number.isFinite(n) && n >= 80 && n <= 160 ? n : fallback;
}

export interface UseThemeOptions {
  /** 配置里的初值（来自 Rust config.json），优先于 localStorage */
  initialAccent?: string | null;
  initialFont?: string | null;
  initialFontScale?: number | null;
  /** 配置加载完成���回调，用于把用户改动回写到 Rust */
  onChange?: (next: { accent: string; font: string; fontScale: number }) => void;
}

/**
 * 主题管理：明暗 + 强调色 + 字体族 + 字号缩放。
 *
 * 三类外观量的落盘分两处：
 * - `theme`（明暗）仍走 localStorage —— 它是**设备级**偏好，跟着用户走。
 * - accent/font/scale 会同时写 localStorage（即时生效、避免闪回默认值）
 *   并通过 `onChange` 回调交给 Rust 持久化（跨设备/重装不丢）。
 */
export function useTheme(options: UseThemeOptions = {}) {
  const { initialAccent, initialFont, initialFontScale, onChange } = options;
  const [theme, setTheme] = useState<Theme>(readInitial);
  const [accentId, setAccentId] = useState<string>(() =>
    resolveAccent(initialAccent ?? readStr(STORAGE_ACCENT, [DEFAULT_ACCENT], DEFAULT_ACCENT)).id,
  );
  const [fontId, setFontId] = useState<string>(() =>
    resolveFont(initialFont ?? readStr(STORAGE_FONT, [DEFAULT_FONT], DEFAULT_FONT)).id,
  );
  const [scale, setScale] = useState<number>(() => {
    const fromConfig = typeof initialFontScale === 'number' ? initialFontScale : NaN;
    return Number.isFinite(fromConfig) && fromConfig >= 80 && fromConfig <= 160
      ? fromConfig
      : readScale(DEFAULT_FONT_SCALE);
  });

  // 明暗主题
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  // 强调色：改写 tokens.css 里的 --color-primary* / --color-accent-soft*
  // 写到 :root.style（内联样式优先级高于样式表），主题切换后依然生效。
  useEffect(() => {
    const a = resolveAccent(accentId);
    const root = document.documentElement.style;
    root.setProperty('--color-primary', a.base);
    root.setProperty('--color-primary-hover', a.hover);
    root.setProperty('--color-primary-active', a.active);
    root.setProperty('--color-accent-soft', a.soft);
    root.setProperty('--color-accent-soft-hover', a.softHover);
  }, [accentId]);

  // 字体族 + 字号缩放：缩放通过改 --font-scale 基准实现，
  // tokens.css 里各档字号都是 calc(基准 * 系数)，故一处生效、整体等比变化。
  useEffect(() => {
    const f = resolveFont(fontId);
    const root = document.documentElement.style;
    root.setProperty('--font-family', f.stack);
    root.setProperty('--font-scale', String(scale / 100));
  }, [fontId, scale]);

  // 配置加载完成后，若 config.json 有值而本地 state 仍是默认值，用配置覆盖一次。
  // 只在「配置确有值」时覆盖，避免抹掉用户刚在设置页改的选择。
  useEffect(() => {
    if (initialAccent) setAccentId(resolveAccent(initialAccent).id);
  }, [initialAccent]);
  useEffect(() => {
    if (initialFont) setFontId(resolveFont(initialFont).id);
  }, [initialFont]);
  useEffect(() => {
    if (typeof initialFontScale === 'number' && initialFontScale >= 80 && initialFontScale <= 160) {
      setScale(initialFontScale);
    }
  }, [initialFontScale]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  /** 三类外观量统一入口：立即生效 + 落 localStorage + 回写 Rust。 */
  const setAccent = useCallback(
    (id: string) => {
      const a = resolveAccent(id);
      setAccentId(a.id);
      localStorage.setItem(STORAGE_ACCENT, a.id);
      onChange?.({ accent: a.id, font: fontId, fontScale: scale });
    },
    [fontId, onChange, scale],
  );

  const setFont = useCallback(
    (id: string) => {
      const f = resolveFont(id);
      setFontId(f.id);
      localStorage.setItem(STORAGE_FONT, f.id);
      onChange?.({ accent: accentId, font: f.id, fontScale: scale });
    },
    [accentId, onChange, scale],
  );

  const setFontScale = useCallback(
    (n: number) => {
      const v = Math.min(160, Math.max(80, Math.round(n)));
      setScale(v);
      localStorage.setItem(STORAGE_SCALE, String(v));
      onChange?.({ accent: accentId, font: fontId, fontScale: v });
    },
    [accentId, fontId, onChange],
  );

  return {
    theme,
    setTheme,
    toggle,
    accentId,
    setAccent,
    fontId,
    setFont,
    fontScale: scale,
    setFontScale,
  };
}
