import React from 'react';
import { IconClear } from '../icons';

/** 生词本条目（与 Rust `WordEntry` 对齐，由 Rust 侧 wordbook 命令返回）。 */
export interface WordEntry {
  id: number;
  /** 选中的原文（词/词组/整句） */
  term: string;
  /** 译文 */
  translation: string;
  /** 划词时所在句子（可空） */
  context?: string | null;
  /** 上下文译文（可空） */
  context_translation?: string | null;
  /** 实际出译文的引擎 */
  engine: string;
  /** 源语言代码 */
  src_lang?: string;
  /** 目标语言代码 */
  dst_lang?: string;
  /** 来源应用进程名（可空） */
  source_app?: string | null;
  /** 创建时间（ISO 8601 / SQLite 时间戳） */
  created_at: string;
}

export interface WordbookProps {
  items?: WordEntry[];
  /** 搜索关键词变化（Rust 侧 `list_words(limit, query)` 过滤） */
  query?: string;
  onQueryChange?: (q: string) => void;
  /** 取消收藏（删除条目） */
  onDelete?: (id: number) => void;
  /** 清空生词本（可选；M1 仅删除单条，预留） */
  onClear?: () => void;
}

const clamp2: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

/** 生词本抽屉：可搜索列表，每条展示词块 / 译文 / 来源 / 时间，支持删除（取消收藏）。 */
export function Wordbook({ items = [], query = '', onQueryChange, onDelete }: WordbookProps) {
  const empty = items.length === 0;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* 搜索框（固定顶部） */}
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
        <input
          type="search"
          value={query}
          placeholder="搜索生词…"
          aria-label="搜索生词"
          onChange={(e) => onQueryChange?.(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '5px 10px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg-container)',
            color: 'var(--color-text-primary)',
            fontSize: 'var(--font-size-sm)',
            outline: 'none',
          }}
        />
      </div>

      {empty ? (
        <div style={{ padding: 'var(--spacing-lg)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', lineHeight: 1.8 }}>
          {query ? '没有匹配的生词。' : '还没有生词。划词后点击「收藏 ★」，词块会出现在这里。'}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 var(--spacing-lg)' }}>
          {items.map((w) => (
            <div
              key={w.id}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '11px 8px',
                margin: '0 -8px',
                borderBottom: '0.5px solid var(--color-hairline)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                    {w.created_at} · {w.engine}
                    {w.source_app ? ` · ${w.source_app}` : ''}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 500, lineHeight: 1.5, color: 'var(--color-text-primary)' }}>
                    {w.term}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.6, color: 'var(--color-text-secondary)', ...clamp2 }}>
                    {w.translation}
                  </div>
                  {w.context ? (
                    <div style={{ fontSize: 'var(--font-size-xs)', lineHeight: 1.6, color: 'var(--color-text-tertiary)', marginTop: 4, ...clamp2 }}>
                      「{w.context}」
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="fs-chip"
                  title="取消收藏"
                  aria-label={`删除生词 ${w.term}`}
                  onClick={() => onDelete?.(w.id)}
                  style={{
                    flex: 'none',
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
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}