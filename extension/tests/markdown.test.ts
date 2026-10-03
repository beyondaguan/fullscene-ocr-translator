/**
 * Markdown 日积累导出工具测试：日期分组、MD 生成、ZIP 生成。
 */
import { describe, expect, it } from 'vitest';
import {
  fmtDate,
  fmtDateTime,
  groupByDate,
  recordsToMarkdown,
  buildDailyMarkdown,
  dailyFileContent,
  makeZip,
} from '../src/shared/markdown';
import type { HistoryItem } from '../src/shared/store';

function makeRecord(overrides: Partial<HistoryItem>): HistoryItem {
  return {
    id: '1',
    sourceText: 'Hello',
    translatedText: '你好',
    sourceLang: 'en',
    targetLang: 'zh',
    engine: 'microsoft',
    ts: new Date(2026, 8, 29, 10, 30).getTime(),
    ...overrides,
  };
}

describe('markdown 导出工具', () => {
  it('fmtDate 格式化为 YYYY-MM-DD', () => {
    expect(fmtDate(new Date(2026, 8, 29).getTime())).toBe('2026-09-29');
  });

  it('fmtDateTime 格式化为 MM-DD HH:mm', () => {
    expect(fmtDateTime(new Date(2026, 8, 29, 10, 30).getTime())).toBe('09-29 10:30');
  });

  it('groupByDate 按日期分组', () => {
    const records = [
      makeRecord({ ts: new Date(2026, 8, 29, 10).getTime() }),
      makeRecord({ ts: new Date(2026, 8, 29, 11).getTime() }),
      makeRecord({ ts: new Date(2026, 8, 28, 9).getTime() }),
    ];
    const groups = groupByDate(records);
    expect(Object.keys(groups).sort()).toEqual(['2026-09-28', '2026-09-29']);
    expect(groups['2026-09-29'].length).toBe(2);
    expect(groups['2026-09-28'].length).toBe(1);
  });

  it('recordsToMarkdown 包含原文与译文', () => {
    const md = recordsToMarkdown([makeRecord({})]);
    expect(md).toContain('## 09-29 10:30');
    expect(md).toContain('**原文**: Hello');
    expect(md).toContain('**译文**: 你好');
    expect(md).toContain('*引擎*: microsoft · en → zh');
  });

  it('buildDailyMarkdown 按日期生成 # 标题与 frontmatter', () => {
    const md = buildDailyMarkdown([
      makeRecord({ ts: new Date(2026, 8, 29, 10).getTime() }),
      makeRecord({ ts: new Date(2026, 8, 28, 9).getTime() }),
    ]);
    expect(md).toContain('# 全场景OCR翻译 2026-09-29');
    expect(md).toContain('# 全场景OCR翻译 2026-09-28');
    expect(md.startsWith('---')).toBe(true);
  });

  it('dailyFileContent 生成单日文件', () => {
    const md = dailyFileContent('2026-09-29', [makeRecord({})]);
    expect(md).toContain('# 全场景OCR翻译 2026-09-29');
    expect(md).toContain('**原文**: Hello');
  });

  it('makeZip 生成合法 ZIP Blob（含文件头 PK）', async () => {
    const blob = makeZip([
      { name: 'FullScene-2026-09-29.md', data: new TextEncoder().encode('# 测试') },
    ]);
    expect(blob.type).toBe('application/zip');
    const buf = new Uint8Array(await blob.arrayBuffer());
    // ZIP 本地文件头签名 PK\x03\x04
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
    // 文件名出现在数据中
    const name = new TextDecoder().decode(buf.subarray(30, 30 + 'FullScene-2026-09-29.md'.length));
    expect(name).toBe('FullScene-2026-09-29.md');
  });
});