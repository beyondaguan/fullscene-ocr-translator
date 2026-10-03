import React from 'react';

export interface TabsProps<T extends string = string> {
  items: { key: T; label: React.ReactNode }[];
  activeKey: T;
  onChange?: (key: T) => void;
}

/** 平级页签（设置页分类导航 / 工作界面布局切换等）。 */
export function Tabs<T extends string = string>({ items, activeKey, onChange }: TabsProps<T>) {
  return (
    <div className="fw-tabs" style={{ display: 'flex', gap: 'var(--spacing-xs)' }}>
      {items.map((it) => {
        const active = it.key === activeKey;
        return (
          <button
            key={it.key}
            onClick={() => onChange?.(it.key)}
            style={{
              border: 'none',
              background: active ? 'var(--color-primary)' : 'transparent',
              color: active ? '#fff' : 'var(--color-text-secondary)',
              padding: '6px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--font-size-sm)',
              cursor: 'pointer',
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}