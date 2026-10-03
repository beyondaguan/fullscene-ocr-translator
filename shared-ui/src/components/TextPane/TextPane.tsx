import React from 'react';

export interface PaneAction {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface TextPaneProps {
  title: string;
  /** 标题右侧的只读元信息（可编辑 · 118 字） */
  meta?: React.ReactNode;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  /** 面板右上角动作（复制 / 朗读 / 重译） */
  actions?: PaneAction[];
  ariaLabel?: string;
}

/**
 * 可编辑文本面板：头部（标题 + 元信息 + 动作）+ 自适应高度的 textarea 主体。
 *
 * 主体刻意用 textarea 而非 <pre>：文本是工作对象，不是展品——用户要在译文上直接改字，
 * 在原文上直接修正 OCR 误识别，改完就能重译或复制，不必借助外部编辑器。
 */
export function TextPane({
  title,
  meta,
  value,
  onChange,
  readOnly = false,
  placeholder,
  actions = [],
  ariaLabel,
}: TextPaneProps) {
  return (
    <section
      className="fs-text-pane"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div
        style={{
          height: 'var(--pane-head-height)',
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '0 var(--spacing-lg)',
          background: 'var(--color-bg-head)',
          borderBottom: '0.5px solid var(--color-hairline)',
        }}
      >
        <span style={{ fontSize: 'var(--font-size-md)', fontWeight: 500 }}>{title}</span>
        {meta && (
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>{meta}</span>
        )}
        {actions.length > 0 && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
            {actions.map((a) => (
              <button
                key={a.key}
                type="button"
                className="fs-chip"
                disabled={a.disabled}
                onClick={a.onClick}
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-text-secondary)',
                  background: 'transparent',
                  border: '0.5px solid var(--color-hairline-strong)',
                  borderRadius: 'var(--radius-md)',
                  padding: '2px 9px',
                  lineHeight: 1.6,
                }}
              >
                {a.label}
              </button>
            ))}
          </span>
        )}
      </div>

      <textarea
        className="fs-text-pane-body"
        aria-label={ariaLabel ?? title}
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange?.(e.target.value)}
        style={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: 'var(--color-text-primary)',
          padding: '14px var(--spacing-lg)',
          fontSize: 'var(--font-size-base)',
          lineHeight: 'var(--line-height-text)',
          overflowY: 'auto',
        }}
      />
    </section>
  );
}
