import React from 'react';

export interface RailItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  /**
   * mode  — 互斥模式（当前只有截图），命中 activeMode 时高亮；
   * action — 一次性动作，点击即执行，不高亮；
   * toggle — 开关型（历史 / 对话 / 设置抽屉），打开时高亮。
   */
  kind?: 'mode' | 'action' | 'toggle';
  disabled?: boolean;
  title?: string;
}

export interface ToolRailProps {
  /** 分组渲染，组与组之间显示发丝线 */
  groups: RailItem[][];
  /** 贴在底部的分组（设置等） */
  footer?: RailItem[];
  /** 当前模式 key */
  activeMode?: string;
  /** 当前打开的抽屉 key（用于 toggle 型高亮） */
  activeToggle?: string;
  onSelect: (key: string) => void;
}

/**
 * 左侧工具栏：按「捕获 → 处理 → 系统」分组，组间一条发丝线。
 * 只放全局动作与模式切换；当前工作区的局部操作（重译 / 语言 / 引擎）归命令条，
 * 避免同一动作在两处重复出现。
 */
export function ToolRail({ groups, footer = [], activeMode, activeToggle, onSelect }: ToolRailProps) {
  const renderItem = (it: RailItem) => {
    const isActive =
      (it.kind === 'mode' && it.key === activeMode) || (it.kind === 'toggle' && it.key === activeToggle);

    return (
      <button
        key={it.key}
        type="button"
        className="fs-rail-item"
        data-active={isActive}
        disabled={it.disabled}
        title={it.title ?? it.label}
        aria-pressed={it.kind === 'mode' ? isActive : undefined}
        onClick={() => onSelect(it.key)}
        style={{
          width: 58,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 3,
          padding: '6px 0',
          border: 'none',
          background: 'transparent',
          color: 'var(--color-text-secondary)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--font-size-xs)',
          lineHeight: 1.2,
        }}
      >
        {it.icon}
        <span>{it.label}</span>
      </button>
    );
  };

  return (
    <nav
      className="fs-tool-rail"
      aria-label="工具栏"
      style={{
        width: 'var(--rail-width)',
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        padding: '8px 0',
        background: 'var(--color-bg-rail)',
        borderRight: '0.5px solid var(--color-hairline)',
        overflowY: 'auto',
      }}
    >
      {groups.map((group, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && (
            <span
              aria-hidden
              style={{
                width: 34,
                height: '0.5px',
                background: 'var(--color-hairline)',
                margin: '6px 0',
                flex: 'none',
              }}
            />
          )}
          {group.map(renderItem)}
        </React.Fragment>
      ))}

      {footer.length > 0 && (
        <>
          <span style={{ flex: 1, minHeight: 12 }} />
          <span
            aria-hidden
            style={{ width: 34, height: '0.5px', background: 'var(--color-hairline)', margin: '6px 0', flex: 'none' }}
          />
          {footer.map(renderItem)}
        </>
      )}
    </nav>
  );
}
