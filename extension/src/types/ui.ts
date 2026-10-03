/**
 * UI 组件与渲染模式类型（Design Tokens / 渲染模式），供 renderer 与 ui-components 使用。
 * 设计令牌与 shared-ui/tokens.css 保持一致（主色 #1677ff）。
 */

/** 渲染模式 */
export type RenderMode = 'bilingual' | 'translation-only' | 'tooltip' | 'inline';

/** 设计令牌 */
export interface DesignTokens {
  primary: string;
  radius: { sm: number; md: number; lg: number };
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number };
}

/** 默认令牌（与 shared-ui/tokens.css 对齐） */
export const DEFAULT_TOKENS: DesignTokens = {
  primary: '#1677ff',
  radius: { sm: 4, md: 8, lg: 16 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
};