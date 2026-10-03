import { useEffect } from 'react';

export type HotkeyCallback = (combo: string) => void;

/** 特殊键名 → 用于匹配的 e.key 值（小写）。 */
const SPECIAL_KEYS: Record<string, string> = {
  backspace: 'backspace',
  delete: 'delete',
  enter: 'enter',
  escape: 'escape',
  space: ' ',
  tab: 'tab',
  home: 'home',
  end: 'end',
  ' ': ' ',
};

/** 页面内快捷键（Alt+1~4 等）：注册 keydown 监听并触发回调。 */
export function useHotkey(combo: string, callback: HotkeyCallback) {
  useEffect(() => {
    const parts = combo
      .split('+')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    const rawKey = parts.find((p) => p.length === 1) ?? parts.find((p) => SPECIAL_KEYS[p]) ?? '';
    const alt = parts.includes('alt');
    const ctrl = parts.includes('ctrl');
    const shift = parts.includes('shift');

    const handler = (e: KeyboardEvent) => {
      if (e.altKey !== alt) return;
      if (e.ctrlKey !== ctrl) return;
      if (e.shiftKey !== shift) return;
      const actual = e.key.toLowerCase();
      const target = rawKey.length === 1 ? rawKey : SPECIAL_KEYS[rawKey];
      if (target !== undefined && actual === target) {
        e.preventDefault();
        callback(combo);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [combo, callback]);
}