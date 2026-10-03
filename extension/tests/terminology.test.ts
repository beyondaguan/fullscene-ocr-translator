/**
 * 术语库单元测试：mask/restore、词边界保护、方向过滤。
 */
import { describe, expect, it } from 'vitest';
import { buildGlossary, maskText, restoreText, BUILTIN_TERMS } from '../src/background/terminology';
import type { TerminologyConfig } from '../src/types/config';

const CONFIG: TerminologyConfig = {
  enabled: true,
  enabledTermBases: ['medical', 'general'],
  customTerms: [{ term: 'FullScene', translation: '全场景' }],
};

describe('terminology', () => {
  it('buildGlossary 按方向过滤并合并自定义术语', () => {
    const en2zh = buildGlossary(CONFIG, 'en', 'zh');
    expect(en2zh.some((t) => t.source === 'prostate cancer')).toBe(true);
    expect(en2zh.some((t) => t.source === 'FullScene')).toBe(true);
    expect(en2zh.some((t) => t.source === '前列腺癌')).toBe(false);

    const zh2en = buildGlossary(CONFIG, 'zh', 'en');
    expect(zh2en.some((t) => t.source === '前列腺癌')).toBe(true);
    expect(zh2en.some((t) => t.source === 'prostate cancer')).toBe(false);
  });

  it('术语未启用时返回空表', () => {
    const glossary = buildGlossary({ enabled: false, customTerms: [] }, 'en', 'zh');
    expect(glossary).toEqual([]);
  });

  it('maskText 替换术语为占位符', () => {
    const entries = buildGlossary(CONFIG, 'en', 'zh');
    const { masked, tokens } = maskText('The patient has prostate cancer.', entries);
    expect(masked).not.toContain('prostate cancer');
    expect(masked).toContain('\uE000');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].target).toBe('前列腺癌');
  });

  it('词边界保护：cat 不匹配 category', () => {
    const { masked } = maskText('a category of cats', [
      { source: 'cat', target: '猫', sourceLang: 'en', targetLang: 'zh' },
    ]);
    // category 中的 cat 不应被替换
    expect(masked).toContain('category');
  });

  it('restoreText 还原规范译文', () => {
    const entries = buildGlossary(CONFIG, 'en', 'zh');
    const { masked, tokens } = maskText('He has prostate cancer.', entries);
    const restored = restoreText(masked, tokens);
    expect(restored).toContain('前列腺癌');
    // 非术语部分保留
    expect(restored).toContain('He has');
  });

  it('内置术语库非空', () => {
    expect(BUILTIN_TERMS.length).toBeGreaterThan(0);
  });
});