/**
 * language 工具单元测试。
 */
import { describe, expect, it } from 'vitest';
import { normalizeLang, sameLangPair, isSupportedLang, parseAcceptLanguage } from '../src/shared/language';

describe('language', () => {
  it('normalizeLang 归一化', () => {
    expect(normalizeLang('EN')).toBe('en');
    expect(normalizeLang('zh-CN')).toBe('zh');
    expect(normalizeLang('  Ja ')).toBe('ja');
  });

  it('sameLangPair 比较语言对', () => {
    expect(sameLangPair({ sourceLang: 'EN', targetLang: 'zh' }, { sourceLang: 'en', targetLang: 'zh-CN' })).toBe(true);
    expect(sameLangPair({ sourceLang: 'en', targetLang: 'zh' }, { sourceLang: 'en', targetLang: 'ja' })).toBe(false);
  });

  it('isSupportedLang', () => {
    expect(isSupportedLang('en')).toBe(true);
    expect(isSupportedLang('zh-CN')).toBe(true);
    expect(isSupportedLang('xx')).toBe(false);
  });

  it('parseAcceptLanguage 按 q 排序', () => {
    const langs = parseAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8');
    expect(langs[0]).toBe('zh');
    expect(langs[1]).toBe('en');
  });
});