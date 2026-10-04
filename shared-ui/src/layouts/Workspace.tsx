import React from 'react';
import { TextPane, type PaneAction } from '../components/TextPane';
import { SplitPane } from '../components/SplitPane';
import { Select, SelectOption } from '../components/Select';
import { Button } from '../components/Button';
import { IconSwap } from '../icons';
import { countChars } from '../utils/text';

export const LANGUAGES: SelectOption[] = [
  { value: 'auto', label: '自动检测' },
  { value: 'en', label: '英语' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'fr', label: '法语' },
  { value: 'de', label: '德语' },
  { value: 'ru', label: '俄语' },
  { value: 'es', label: '西班牙语' },
];

export const ENGINES: SelectOption[] = [
  { value: 'mymemory', label: 'MyMemory（免密钥）' },
  { value: 'google', label: 'Google（免密钥）' },
  { value: 'local-llm', label: '本地大模型' },
  { value: 'siliconflow', label: 'SiliconFlow' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'edge', label: 'Microsoft Edge/Azure' },
  { value: 'bing', label: 'Bing' },
];

const PLACEHOLDER_TRANSLATION = '译文会显示在这里。这一栏可以直接编辑，改完即用。';
const PLACEHOLDER_SOURCE = '按 Alt+Q 十字框选，或 Ctrl+Alt+O 整屏截图，或 Ctrl+V 粘贴文本；OCR 结果会出现在这里，识别错字可直接改。';

export interface WorkspaceProps {
  source: string;
  translation: string;
  onChangeSource: (value: string) => void;
  onChangeTranslation: (value: string) => void;
  loading?: boolean;
  error?: string;
  srcLang: string;
  dstLang: string;
  engine: string;
  onLangChange: (which: 'src' | 'dst', value: string) => void;
  onSwapLang: () => void;
  onEngineChange: (value: string) => void;
  onRetranslate: () => void;
  onCopy: (which: 'source' | 'translation') => void;
  onSpeak: (which: 'source' | 'translation') => void;
  /** 收藏当前译文（写生词本 + toast 反馈） */
  onFavorite?: () => void;
  /** 划词「详解」：开启后显示「详解」按钮（复用 AI 助手，注入当前译文上下文） */
  detailVisible?: boolean;
  /** 点击「详解」按钮（通常为：打开 AI 助手抽屉 + 预填请求） */
  onDetail?: () => void;
  speakSupported?: boolean;
  engines?: SelectOption[];
}

/**
 * 工作区画布：命令条（可改项）+ 上下分栏（译文在上 / 原文·OCR 在下）。
 *
 * 为什么译文在上：阅读顺序是「先看结论，再看依据」。校对译文的动作永远是
 * 「看一眼译文 → 回到原文找对应」，把译文放上面，视线落点就是最终产物，
 * 需要核对时才下移——反过来则每次都要先掠过原文才能读到结果。
 */
export function Workspace({
  source,
  translation,
  onChangeSource,
  onChangeTranslation,
  loading = false,
  error,
  srcLang,
  dstLang,
  engine,
  onLangChange,
  onSwapLang,
  onEngineChange,
  onRetranslate,
  onCopy,
  onSpeak,
  onFavorite,
  detailVisible = false,
  onDetail,
  speakSupported = false,
  engines = ENGINES,
}: WorkspaceProps) {
  const [ratio, setRatio] = React.useState(0.5);
  const empty = !source && !translation;

  const sep = <span aria-hidden style={{ width: 1, height: 16, background: 'var(--color-hairline)', flex: 'none' }} />;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        className="fs-command-bar"
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
        <Button variant="primary" size="sm" onClick={onRetranslate} disabled={!source || loading}>
          {loading ? '翻译中…' : '重新翻译'}
        </Button>

        {empty && (
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
            Alt+Q 框选 · Ctrl+Alt+O 整屏 · Ctrl+V 粘贴
          </span>
        )}
        {error && (
          <span
            role="alert"
            style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-error)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {error}
          </span>
        )}

        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <Select
            ariaLabel="源语言"
            value={srcLang}
            options={LANGUAGES}
            onChange={(v) => onLangChange('src', v)}
          />
          <button
            type="button"
            className="fs-icon-btn"
            aria-label="交换语言"
            title="交换源语言与目标语言"
            onClick={onSwapLang}
            style={{
              width: 28,
              height: 28,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-tertiary)',
              borderRadius: 'var(--radius-md)',
              flex: 'none',
            }}
          >
            <IconSwap size={15} />
          </button>
          <Select
            ariaLabel="目标语言"
            value={dstLang}
            options={LANGUAGES}
            onChange={(v) => onLangChange('dst', v)}
          />
          {sep}
          <Select
            ariaLabel="翻译引擎"
            title="翻译引擎"
            emphasis
            value={engine}
            options={engines}
            onChange={onEngineChange}
          />
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0 }} aria-busy={loading}>
        <SplitPane
          direction="vertical"
          ratio={ratio}
          onRatioChange={setRatio}
          first={
            <TextPane
              title="译文"
              meta={`${countChars(translation)} 字`}
              value={translation}
              onChange={onChangeTranslation}
              placeholder={PLACEHOLDER_TRANSLATION}
              actions={buildTranslationActions({
                translation,
                speakSupported,
                onCopy,
                onSpeak,
                onFavorite,
                detailVisible,
                onDetail,
              })}
            />
          }
          second={
            <TextPane
              title="原文 · OCR"
              meta={`${countChars(source)} 字`}
              value={source}
              onChange={onChangeSource}
              placeholder={PLACEHOLDER_SOURCE}
              actions={[
                { key: 'copy', label: '复制', onClick: () => onCopy('source'), disabled: !source },
                { key: 'retranslate', label: '重译', onClick: onRetranslate, disabled: !source || loading },
              ]}
            />
          }
        />
      </div>
    </div>
  );
}

/** 译文面板右上角动作：收藏 / 详解 / 复制 / 朗读。 */
function buildTranslationActions(args: {
  translation: string;
  speakSupported: boolean;
  onCopy: (which: 'source' | 'translation') => void;
  onSpeak: (which: 'source' | 'translation') => void;
  onFavorite?: () => void;
  detailVisible: boolean;
  onDetail?: () => void;
}): PaneAction[] {
  const { translation, speakSupported, onCopy, onSpeak, onFavorite, detailVisible, onDetail } = args;
  const actions: PaneAction[] = [];
  if (onFavorite) {
    actions.push({ key: 'favorite', label: '收藏', onClick: () => onFavorite(), disabled: !translation });
  }
  // 「详解」仅在开关开启（detailVisible）时渲染；无 AI 密钥时不渲染。
  if (detailVisible && onDetail) {
    actions.push({ key: 'detail', label: '详解', onClick: onDetail, disabled: !translation });
  }
  actions.push({ key: 'copy', label: '复制', onClick: () => onCopy('translation'), disabled: !translation });
  actions.push({
    key: 'speak',
    label: '朗读',
    onClick: () => onSpeak('translation'),
    disabled: !translation || !speakSupported,
  });
  return actions;
}
