import React from 'react';
import { IconClear } from '../icons';

export interface HistoryItem {
  id: number;
  source: string;
  target: string;
  engine: string;
  created_at: string;
}

export interface HistoryProps {
  items?: HistoryItem[];
  /** 点击某条记录，把原文/译文回填到画布 */
  onPick?: (item: HistoryItem) => void;
  onClear?: () => void;
}

const clamp2: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

/** 翻译历史：扁平列表，点击即回填画布，不打开新窗口、不跳页。 */
export function History({ items = [], onPick, onClear }: HistoryProps) {
  if (items.length === 0) {
    return (
      <div style={{ padding: 'var(--spacing-lg)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', lineHeight: 1.8 }}>
        还没有翻译记录。完成一次截图翻译后，记录会出现在这里。
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-sm)',
          padding: '8px var(--spacing-lg)',
          borderBottom: '0.5px solid var(--color-hairline)',
        }}
      >
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
          共 {items.length} 条
        </span>
        <button
          type="button"
          className="fs-chip"
          onClick={onClear}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-secondary)',
            background: 'transparent',
            border: '0.5px solid var(--color-hairline-strong)',
            borderRadius: 'var(--radius-md)',
            padding: '2px 9px',
          }}
        >
          <IconClear size={13} />
          清空
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 var(--spacing-lg)' }}>
        {items.map((h) => (
          <button
            key={h.id}
            type="button"
            className="fs-chip"
            title="回填到画布"
            onClick={() => onPick?.(h)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '11px 8px',
              margin: '0 -8px',
              border: 'none',
              background: 'transparent',
              borderBottom: '0.5px solid var(--color-hairline)',
              borderRadius: 'var(--radius-md)',
              color: 'inherit',
            }}
          >
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
              {h.created_at} · {h.engine}
            </div>
            <div style={{ fontSize: 'var(--font-size-md)', lineHeight: 1.6, ...clamp2 }}>{h.target || h.source}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
