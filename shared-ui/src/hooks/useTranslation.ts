import { useCallback, useState } from 'react';

export interface TranslationState {
  loading: boolean;
  original: string;
  translation: string;
  error?: string;
}

const initial: TranslationState = { loading: false, original: '', translation: '' };

export interface TranslationApi {
  /** 调用本地大模型翻译（软件主体侧） */
  translate: (text: string, src: string, dst: string) => Promise<string>;
}

/** 翻译状态管理：封装「发起翻译 → loading → 结果/错误」。 */
export function useTranslation(api: TranslationApi) {
  const [state, setState] = useState<TranslationState>(initial);

  const translate = useCallback(
    async (text: string, src: string, dst: string) => {
      if (!text.trim()) return '';
      setState((s) => ({ ...s, loading: true, original: text, error: undefined }));
      try {
        const translation = await api.translate(text, src, dst);
        setState({ loading: false, original: text, translation, error: undefined });
        return translation;
      } catch (e) {
        setState((s) => ({ ...s, loading: false, error: String(e) }));
        throw e;
      }
    },
    [api],
  );

  const reset = useCallback(() => setState(initial), []);

  return { ...state, translate, reset };
}