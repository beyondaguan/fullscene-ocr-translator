import React from 'react';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  visible?: boolean;
  style?: React.CSSProperties;
}

/**
 * 划词弹窗基准设计语言：跟随选区的毛玻璃浮层。
 * 浏览器扩展的划词弹窗与本组件共用视觉规范（见 交付.md 模式2）。
 */
export function Tooltip({ content, children, visible = false, style }: TooltipProps) {
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {children}
      {visible && (
        <div
          className="fw-tooltip"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            zIndex: 1000,
            minWidth: 200,
            maxWidth: 360,
            padding: 'var(--spacing-sm) var(--spacing-md)',
            borderRadius: 'var(--radius-lg)',
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text-primary)',
            background: 'rgba(255, 255, 255, 0.85)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.3)',
            boxShadow: 'var(--shadow-lg)',
            ...style,
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}