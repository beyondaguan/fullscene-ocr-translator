import React from 'react';

export interface SplitPaneProps {
  /** horizontal = 左右分栏（分隔条竖直）；vertical = 上下分栏（分隔条水平） */
  direction: 'horizontal' | 'vertical';
  /** 第一栏占比 0~1 */
  ratio: number;
  onRatioChange?: (ratio: number) => void;
  /** 最小占比 */
  min?: number;
  /** 最大占比 */
  max?: number;
  /** 双击分隔条复位到的占比 */
  resetRatio?: number;
  first: React.ReactNode;
  second: React.ReactNode;
}

/**
 * 可拖拽双栏容器。
 *
 * 与首版的两点关键差异：
 * 1. 比例基于**自身容器尺寸**换算。原实现用 window.innerWidth/Height，一旦容器不是全宽
 *    （例如左侧还有工具栏、或抽屉占位），拖动量与视觉位移就会不相等。
 * 2. 分隔条命中区 9px、视觉把手 36px，两者分离。用户不必把鼠标精确停在 1px 线上，
 *    同时视觉上仍是干净的细线——命中区属于手感，不属于视觉。
 */
export function SplitPane({
  direction,
  ratio,
  onRatioChange,
  min = 0.15,
  max = 0.85,
  resetRatio = 0.5,
  first,
  second,
}: SplitPaneProps) {
  const isH = direction === 'horizontal';
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = React.useState(false);

  const clamp = React.useCallback((r: number) => Math.min(max, Math.max(min, r)), [min, max]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const total = isH ? rect.width : rect.height;
    if (total <= 0) return;

    setDragging(true);
    document.body.classList.add('fs-dragging');

    const move = (ev: PointerEvent) => {
      const pos = isH ? ev.clientX - rect.left : ev.clientY - rect.top;
      onRatioChange?.(clamp(pos / total));
    };
    const up = () => {
      setDragging(false);
      document.body.classList.remove('fs-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.05 : 0.02;
    const dec = isH ? 'ArrowLeft' : 'ArrowUp';
    const inc = isH ? 'ArrowRight' : 'ArrowDown';
    if (e.key === dec) {
      e.preventDefault();
      onRatioChange?.(clamp(ratio - step));
    } else if (e.key === inc) {
      e.preventDefault();
      onRatioChange?.(clamp(ratio + step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onRatioChange?.(clamp(resetRatio));
    }
  };

  const firstSize: React.CSSProperties = isH
    ? { width: `${ratio * 100}%`, flex: 'none', minWidth: 0 }
    : { height: `${ratio * 100}%`, flex: 'none', minHeight: 0 };

  return (
    <div
      ref={containerRef}
      className="fs-split-pane"
      style={{
        display: 'flex',
        flexDirection: isH ? 'row' : 'column',
        height: '100%',
        width: '100%',
        minHeight: 0,
      }}
    >
      <div style={firstSize}>{first}</div>

      <div
        className="fs-splitter"
        data-dragging={dragging}
        role="separator"
        aria-orientation={isH ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onDoubleClick={() => onRatioChange?.(clamp(resetRatio))}
        onKeyDown={onKeyDown}
        style={{
          flex: 'none',
          ...(isH ? { width: 9, cursor: 'col-resize' } : { height: 9, cursor: 'row-resize' }),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-bg-track)',
          touchAction: 'none',
        }}
      >
        <span
          className="fs-splitter-handle"
          aria-hidden
          style={{
            width: isH ? 2.5 : 36,
            height: isH ? 36 : 2.5,
            borderRadius: 2,
            background: 'var(--color-hairline-strong)',
            transition: 'background var(--duration-fast) var(--ease-out)',
          }}
        />
      </div>

      <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{second}</div>
    </div>
  );
}
