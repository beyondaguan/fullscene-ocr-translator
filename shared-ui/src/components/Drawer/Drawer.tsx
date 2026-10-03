import React from 'react';
import { IconClose } from '../../icons';

export interface DrawerProps {
  open: boolean;
  title: string;
  subtitle?: React.ReactNode;
  /** 抽屉宽度，默认取 --drawer-width */
  width?: number;
  onClose?: () => void;
  /** 标题下方的上下文行（如「已引用当前译文 118 字」） */
  context?: React.ReactNode;
  /** 底部固定区（对话输入框等） */
  footer?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * 右侧滑出抽屉：覆盖在画布之上，不跳页、不卸载画布。
 *
 * 刻意不设为 aria-modal —— 抽屉打开时主画布仍可读可操作（这正是「视野不脱离」的实现），
 * 因此语义上它是一块非阻断的辅助面板，而不是一个模态对话框。
 */
export function Drawer({
  open,
  title,
  subtitle,
  width,
  onClose,
  context,
  footer,
  children,
}: DrawerProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        className="fs-scrim"
        onClick={onClose}
        aria-hidden
        style={{ position: 'absolute', inset: 0, background: 'var(--color-bg-mask)', zIndex: 20 }}
      />
      <aside
        className="fs-drawer"
        role="dialog"
        aria-modal={false}
        aria-label={title}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: width ?? 'var(--drawer-width)',
          maxWidth: '100%',
          zIndex: 21,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-bg-container)',
          borderLeft: '0.5px solid var(--color-hairline-strong)',
          boxShadow: 'var(--shadow-drawer)',
        }}
      >
        <div
          style={{
            height: 'var(--cmdbar-height)',
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--spacing-sm)',
            padding: '0 var(--spacing-lg)',
            borderBottom: '0.5px solid var(--color-hairline)',
          }}
        >
          <span style={{ fontSize: 'var(--font-size-md)', fontWeight: 500 }}>{title}</span>
          {subtitle && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
              {subtitle}
            </span>
          )}
          <button
            type="button"
            className="fs-icon-btn"
            aria-label="关闭"
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              width: 26,
              height: 26,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-tertiary)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <IconClose size={15} />
          </button>
        </div>

        {context && (
          <div
            style={{
              flex: 'none',
              padding: '10px var(--spacing-lg)',
              borderBottom: '0.5px solid var(--color-hairline)',
              display: 'flex',
              alignItems: 'center',
              gap: 7,
            }}
          >
            {context}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {children}
        </div>

        {footer && (
          <div
            style={{
              flex: 'none',
              borderTop: '0.5px solid var(--color-hairline)',
              padding: 'var(--spacing-md) var(--spacing-lg)',
            }}
          >
            {footer}
          </div>
        )}
      </aside>
    </>
  );
}
