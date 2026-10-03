/** 文本统计：中英混排下按「非空白字符」计，与状态栏的「字数」口径一致。 */
export function countChars(text: string): number {
  if (!text) return 0;
  return text.replace(/\s+/g, '').length;
}

/** 估算朗读/翻译耗时展示用：毫秒 → 人读字符串。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
