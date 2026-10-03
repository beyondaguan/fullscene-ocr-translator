import React from 'react';

export interface PanelProps {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

/** 内容面板：可选 header / footer，用于工作界面原文区/翻译区外壳。 */
export function Panel({ header, footer, children, style }: PanelProps) {
  return (
    <div
      className="fw-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--color-bg-container)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--color-border)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {header && (
        <div style={{ padding: 'var(--spacing-sm) var(--spacing-md)', borderBottom: '1px solid var(--color-border)', fontWeight: 600 }}>
          {header}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: 'var(--spacing-md)' }}>{children}</div>
      {footer && (
        <div style={{ padding: 'var(--spacing-sm) var(--spacing-md)', borderTop: '1px solid var(--color-border)' }}>
          {footer}
        </div>
      )}
    </div>
  );
}