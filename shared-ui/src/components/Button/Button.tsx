import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'default' | 'text';
  size?: 'sm' | 'md' | 'lg';
}

export function Button({ variant = 'default', size = 'md', ...rest }: ButtonProps) {
  const style: React.CSSProperties = {
    borderRadius: 'var(--radius-md)',
    border: variant === 'text' ? 'none' : '1px solid var(--color-border)',
    background:
      variant === 'primary' ? 'var(--color-primary)' : variant === 'text' ? 'transparent' : 'var(--color-bg-container)',
    color: variant === 'primary' ? '#fff' : 'var(--color-text-primary)',
    padding: size === 'sm' ? '4px 10px' : size === 'lg' ? '10px 20px' : '6px 14px',
    fontSize: size === 'sm' ? 'var(--font-size-sm)' : 'var(--font-size-md)',
    cursor: 'pointer',
    transition: 'background var(--duration-fast) var(--ease-out)',
  };
  return <button className="fw-button" style={style} {...rest} />;
}