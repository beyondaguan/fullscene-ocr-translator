/**
 * 主题色板与字体族常量表（配置项 `ui_accent` / `ui_font` 的取值来源）。
 *
 * 设计约束：
 * - **只存 id，不存 CSS 值**。配置落在 config.json，id 稳定、值可随版本调整；
 *   改名/调色不会让用户的旧配置失效。
 * - 每个 accent 必须给出一整套派生色（hover/active/soft），因为 tokens.css
 *   的层级与状态都依赖它们，只换主色会出现「按下没反应」这类断裂。
 * - 所有色在浅色/深色两套主题下都要保证文字对比度 ≥ 4.5:1（WCAG AA）。
 */

/** 主题色板。`id` 写入配置，`label` 是设置页显示名。 */
export interface Accent {
  id: string;
  label: string;
  /** 主色：按钮、选中态、强调文字 */
  base: string;
  /** 悬停态 */
  hover: string;
  /** 按下态 */
  active: string;
  /** 极淡背景：标签底色、高亮区块 */
  soft: string;
  /** 淡背景悬停态 */
  softHover: string;
}

export const ACCENTS: Accent[] = [
  {
    id: 'blue',
    label: '经典蓝（默认）',
    base: '#1677ff',
    hover: '#4096ff',
    active: '#0958d9',
    soft: 'rgba(22, 119, 255, 0.1)',
    softHover: 'rgba(22, 119, 255, 0.18)',
  },
  {
    id: 'green',
    label: '松石绿',
    base: '#13a8a8',
    hover: '#33bcbc',
    active: '#0b8282',
    soft: 'rgba(19, 168, 168, 0.1)',
    softHover: 'rgba(19, 168, 168, 0.18)',
  },
  {
    id: 'purple',
    label: '藤紫',
    base: '#722ed1',
    hover: '#9254de',
    active: '#551b99',
    soft: 'rgba(114, 46, 209, 0.1)',
    softHover: 'rgba(114, 46, 209, 0.18)',
  },
  {
    id: 'orange',
    label: '暖橙',
    base: '#d46b08',
    hover: '#e88a2b',
    active: '#a8500a',
    soft: 'rgba(212, 107, 8, 0.1)',
    softHover: 'rgba(212, 107, 8, 0.18)',
  },
  {
    id: 'crimson',
    label: '胭脂红',
    base: '#cf1322',
    hover: '#e04a52',
    active: '#a40e26',
    soft: 'rgba(207, 19, 34, 0.1)',
    softHover: 'rgba(207, 19, 34, 0.18)',
  },
  {
    id: 'slate',
    label: '石墨灰',
    base: '#4a5568',
    hover: '#667085',
    active: '#2d3748',
    soft: 'rgba(74, 85, 104, 0.1)',
    softHover: 'rgba(74, 85, 104, 0.18)',
  },
];

/** 默认色板 id（与 tokens.css 里写死的蓝一致）。 */
export const DEFAULT_ACCENT = 'blue';

/**
 * 界面字体族。
 *
 * 全部优先使用 Windows 10/11 自带字体——小工具不应要求用户额外安装字体。
 * `stack` 里的回退链保证在字体缺失时落到系统 UI 字体而非 serif（衬线在
 * 中文界面里观感差异极大，不可接受）。
 */
export interface FontFamily {
  id: string;
  label: string;
  stack: string;
}

const UI_FALLBACK = `"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif`;

export const FONT_FAMILIES: FontFamily[] = [
  {
    id: 'system',
    label: '系统默认（推荐）',
    stack: UI_FALLBACK,
  },
  {
    id: 'yahei',
    label: '微软雅黑',
    // 雅黑是 Windows 中文默认，字面清晰、屏幕阅读友好
    stack: `"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif`,
  },
  {
    id: 'segoe',
    label: 'Segoe UI',
    stack: `"Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif`,
  },
  {
    id: 'mono',
    // 等宽：适合逐字核对译文，但中文观感偏硬，故排在后面
    label: '等宽（Consolas）',
    stack: `Consolas, "Cascadia Mono", "Microsoft YaHei UI", monospace`,
  },
  {
    id: 'serif',
    label: '衬线（宋体）',
    stack: `"SimSun", "Songti SC", Georgia, "Microsoft YaHei UI", serif`,
  },
];

export const DEFAULT_FONT = 'system';

/** 界面字号缩放档位（%）。范围与 settings.schema.json 的 80–160 一致。 */
export const FONT_SCALES: number[] = [80, 90, 100, 110, 125, 150];

export const DEFAULT_FONT_SCALE = 100;

/** 按 id 取色板；未知 id 回退默认（配置被手改成非法值时不至于白屏）。 */
export function resolveAccent(id: string | null | undefined): Accent {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
}

/** 按 id 取字体；未知 id 回退系统默认。 */
export function resolveFont(id: string | null | undefined): FontFamily {
  return FONT_FAMILIES.find((f) => f.id === id) ?? FONT_FAMILIES[0];
}
