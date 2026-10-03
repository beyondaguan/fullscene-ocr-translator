import React from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
}

/** 开关（设置页开关项）。 */
export function Switch({ checked, onChange, disabled, label }: SwitchProps) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-sm)', cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        style={{
          width: 40,
          height: 22,
          borderRadius: 11,
          border: 'none',
          background: checked ? 'var(--color-primary)' : 'var(--color-border)',
          position: 'relative',
          transition: 'background var(--duration-fast) var(--ease-out)',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 20 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left var(--duration-fast) var(--ease-out)',
          }}
        />
      </button>
      {label && <span>{label}</span>}
    </label>
  );
}