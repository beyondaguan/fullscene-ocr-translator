import React from 'react';

export interface CardProps {
  title?: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export function Card({ title, extra, children, style }: CardProps) {
  return (
    <div
      className="fw-card"
      style={{
        background: 'var(--color-bg-container)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--color-border)',
        boxShadow: 'var(--shadow-sm)',
        padding: 'var(--spacing-lg)',
        ...style,
      }}
    >
      {(title || extra) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--spacing-md)' }}>
          <div style={{ fontWeight: 600 }}>{title}</div>
          <div>{extra}</div>
        </div>
      )}
      {children}
    </div>
  );
}