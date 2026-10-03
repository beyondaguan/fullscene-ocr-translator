import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Input({ label, style, ...rest }: InputProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)', ...style }}>
      {label && <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{label}</span>}
      <input
        style={{
          padding: 'var(--spacing-sm) var(--spacing-md)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border)',
          background: 'var(--color-bg-container)',
          color: 'var(--color-text-primary)',
          outline: 'none',
          transition: 'border-color var(--duration-fast) var(--ease-out)',
        }}
        {...rest}
      />
    </label>
  );
}