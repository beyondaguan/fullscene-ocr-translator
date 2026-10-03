import React from 'react';

export interface SliderProps {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange?: (value: number) => void;
  label?: React.ReactNode;
}

/** 滑条（设置项精细调节）。 */
export function Slider({ min, max, step = 1, value, onChange, label }: SliderProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
      {label && <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{label}</span>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange?.(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--color-primary)' }}
      />
    </label>
  );
}