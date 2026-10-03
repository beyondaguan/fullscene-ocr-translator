import React from 'react';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatProps {
  messages?: ChatMessage[];
  streaming?: boolean;
  /** 抽屉宽度窄，输入区留在面板内底部，保证滚动区与输入区互不挤压 */
  onSend?: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * AI 对话（无气泡）。
 *
 * 气泡用「色块 + 圆角 + 左右对齐」三重编码去表达「谁说的」这一件事，是纯冗余；
 * 换成一个 11px 角色标签，其余交给段落与留白——同一屏能多读一倍的字。
 * 水平与竖直空间也一并省下：气泡的左右缩进在窄抽屉里会白白吃掉 40% 宽度。
 */
export function Chat({
  messages = [],
  streaming = false,
  onSend,
  disabled = false,
  placeholder = '继续追问…（Enter 发送，Shift+Enter 换行）',
}: ChatProps) {
  const [text, setText] = React.useState('');

  const submit = () => {
    const value = text.trim();
    if (!value || streaming || disabled) return;
    onSend?.(value);
    setText('');
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '2px var(--spacing-lg) 8px' }}>
        {messages.length === 0 && !streaming && (
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--color-text-tertiary)',
              lineHeight: 1.8,
              marginTop: 16,
            }}
          >
            就当前画布里的原文与译文提问，例如让它改写成患者能看懂的说法、补一句治疗建议，或核对某个术语。
          </p>
        )}

        {messages.map((m, i) => {
          const isUser = m.role === 'user';
          return (
            <div
              key={i}
              style={{
                padding: '12px 0',
                borderBottom: i === messages.length - 1 && !streaming ? 'none' : '0.5px solid var(--color-hairline)',
              }}
            >
              <div
                style={{
                  fontSize: 'var(--font-size-xs)',
                  marginBottom: 5,
                  color: isUser ? 'var(--color-text-tertiary)' : 'var(--color-primary)',
                }}
              >
                {isUser ? '你' : '助手'}
              </div>
              <div
                style={{
                  fontSize: 'var(--font-size-md)',
                  lineHeight: 'var(--line-height-text)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {m.content}
                {streaming && i === messages.length - 1 && !isUser && (
                  <span
                    aria-hidden
                    className="fs-caret"
                    style={{
                      display: 'inline-block',
                      width: 1.5,
                      height: 14,
                      background: 'var(--color-primary)',
                      verticalAlign: -2,
                      marginLeft: 1,
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}

        {streaming && messages[messages.length - 1]?.role === 'user' && (
          <div style={{ padding: '12px 0' }}>
            <div style={{ fontSize: 'var(--font-size-xs)', marginBottom: 5, color: 'var(--color-primary)' }}>助手</div>
            <div
              aria-hidden
              style={{
                display: 'inline-block',
                width: 1.5,
                height: 14,
                background: 'var(--color-primary)',
                verticalAlign: -2,
              }}
            />
          </div>
        )}
      </div>

      <div
        style={{
          flex: 'none',
          padding: '10px var(--spacing-lg)',
          borderTop: '0.5px solid var(--color-hairline)',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 'var(--spacing-sm)',
        }}
      >
        <textarea
          className="fs-chat-input"
          value={text}
          rows={2}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="消息输入"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            maxHeight: 96,
            padding: '8px 10px',
            fontSize: 'var(--font-size-md)',
            lineHeight: 1.6,
            border: '0.5px solid var(--color-hairline-strong)',
            borderRadius: 'var(--radius-md)',
            background: 'transparent',
            outline: 'none',
          }}
        />
        <button
          type="button"
          className="fs-chip"
          disabled={!text.trim() || streaming || disabled}
          onClick={submit}
          style={{
            flex: 'none',
            fontSize: 'var(--font-size-md)',
            padding: '7px 14px',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-accent-soft)',
            color: 'var(--color-primary)',
          }}
        >
          发送
        </button>
      </div>
    </div>
  );
}
