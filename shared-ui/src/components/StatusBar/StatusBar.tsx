import React from 'react';

export type StatusTone = 'ok' | 'warn' | 'error' | 'idle';

const TONE_COLOR: Record<StatusTone, string> = {
  ok: 'var(--color-success)',
  warn: 'var(--color-warning)',
  error: 'var(--color-error)',
  idle: 'var(--color-text-tertiary)',
};

/** 状态圆点：用于「OCR 就绪 / 降级」这类二值健康状态。 */
export function StatusDot({ tone = 'ok' }: { tone?: StatusTone }) {
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: TONE_COLOR[tone],
        flex: 'none',
        display: 'inline-block',
      }}
    />
  );
}

export interface StatusBarProps {
  /** 左侧只读状态（引擎 / 语言 / 术语库…） */
  left?: React.ReactNode[];
  /** 右侧只读状态（字数 / 耗时 / 进度…） */
  right?: React.ReactNode[];
}

/**
 * 底部状态栏：只读。可修改的同名信息放在命令条，这里只做「持续可见的观测面」，
 * 因此不提供任何交互控件——状态栏一旦可点，它就不再是状态栏而是工具栏。
 */
export function StatusBar({ left = [], right = [] }: StatusBarProps) {
  return (
    <footer
      className="fs-status-bar"
      aria-label="状态栏"
      style={{
        height: 'var(--status-height)',
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-lg)',
        padding: '0 var(--spacing-lg)',
        borderTop: '0.5px solid var(--color-hairline)',
        background: 'var(--color-bg-head)',
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-text-secondary)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {left.map((node, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          {node}
        </span>
      ))}
      <span style={{ flex: 1, minWidth: 8 }} />
      {right.map((node, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          {node}
        </span>
      ))}
    </footer>
  );
}
