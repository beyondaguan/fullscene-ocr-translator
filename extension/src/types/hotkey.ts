/**
 * 快捷键类型与配置结构：组合键、动作、冲突回退。
 * 骨架只保留浏览器扩展实际用到的动作。
 */

/** 组合键 */
export interface HotkeyCombo {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  key: string;
}

/** 动作枚举（骨架裁剪：仅扩展侧动作） */
export type HotkeyAction = 'open-sidebar' | 'translate-selection';

/** 绑定：primary + fallback（冲突时回退） */
export interface HotkeyBinding {
  action: HotkeyAction;
  primary: HotkeyCombo;
  fallback: HotkeyCombo;
}