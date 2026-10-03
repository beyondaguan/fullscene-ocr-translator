import { IconChevronDown } from '../../icons';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  title?: string;
  /** 强调为当前关键设置（如翻译引擎） */
  emphasis?: boolean;
}

/**
 * 极简下拉：保留原生 select（键盘、输入法、无障碍全部免费），只做外观收敛。
 * 不用自绘下拉——自绘要让出滚动、虚拟列表、移动端选择器和输入法，
 * 收益只有「好看一点」，不划算。
 */
export function Select({ value, options, onChange, ariaLabel, title, emphasis }: SelectProps) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <select
        className="fs-chip"
        aria-label={ariaLabel}
        title={title}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          appearance: 'none',
          WebkitAppearance: 'none',
          border: '0.5px solid transparent',
          background: 'transparent',
          color: emphasis ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
          padding: '4px 22px 4px 8px',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--font-size-md)',
          cursor: 'pointer',
          maxWidth: 320,
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          right: 6,
          display: 'inline-flex',
          pointerEvents: 'none',
          color: 'var(--color-text-tertiary)',
        }}
      >
        <IconChevronDown size={13} />
      </span>
    </span>
  );
}
