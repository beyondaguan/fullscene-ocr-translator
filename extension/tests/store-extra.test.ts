/**
 * store 扩展能力测试：生词本增删清空 + 侧栏草稿（浮窗「送侧栏」通道）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addVocabulary,
  loadVocabulary,
  removeVocabulary,
  clearVocabulary,
  toggleVocabFavorite,
  sortVocabulary,
  saveSidebarDraft,
  loadSidebarDraft,
  clearSidebarDraft,
} from '../src/shared/store';

describe('生词本', () => {
  beforeEach(async () => {
    await clearVocabulary();
  });

  it('添加生词后可读取，且同词同语言不重复', async () => {
    await addVocabulary({ term: 'prostate', translation: '前列腺', sourceLang: 'en', targetLang: 'zh' });
    await addVocabulary({ term: 'prostate', translation: '前列腺', sourceLang: 'en', targetLang: 'zh' });

    const list = await loadVocabulary();
    expect(list.length).toBe(1);
    expect(list[0].term).toBe('prostate');
    expect(list[0].reviewCount).toBe(0);
  });

  it('删除生词后列表为空', async () => {
    const list = await addVocabulary({ term: 'bladder', translation: '膀胱', sourceLang: 'en', targetLang: 'zh' });
    const after = await removeVocabulary(list[0].id);
    expect(after.length).toBe(0);
  });

  it('新加入的生词默认未收藏', async () => {
    const list = await addVocabulary({ term: 'kidney', translation: '肾', sourceLang: 'en', targetLang: 'zh' });
    expect(list[0].favorite).toBe(false);
    // 旧版本写入的数据没有 favorite 字段，读取时必须补齐默认值而不是 undefined
    expect((await loadVocabulary())[0].favorite).toBe(false);
  });

  it('收藏可切换并持久化，取消后回到未收藏', async () => {
    const list = await addVocabulary({ term: 'stone', translation: '结石', sourceLang: 'en', targetLang: 'zh' });
    const id = list[0].id;

    const faved = await toggleVocabFavorite(id);
    expect(faved.find((v) => v.id === id)?.favorite).toBe(true);
    expect((await loadVocabulary()).find((v) => v.id === id)?.favorite).toBe(true);

    const unfaved = await toggleVocabFavorite(id);
    expect(unfaved.find((v) => v.id === id)?.favorite).toBe(false);
  });

  it('已存在生词被重复添加时保留收藏状态（不会被重置）', async () => {
    const first = await addVocabulary({ term: 'ureter', translation: '输尿管', sourceLang: 'en', targetLang: 'zh' });
    await toggleVocabFavorite(first[0].id);
    await addVocabulary({ term: 'ureter', translation: '输尿管', sourceLang: 'en', targetLang: 'zh' });
    const list = await loadVocabulary();
    expect(list.length).toBe(1);
    expect(list[0].favorite).toBe(true);
  });

  it('sortVocabulary：收藏置顶，同组内按时间倒序', () => {
    const base = Date.now();
    const list = [
      { id: 'a', term: 'a', translation: 'a', sourceLang: 'en', targetLang: 'zh', ts: base, reviewCount: 0, favorite: false },
      { id: 'b', term: 'b', translation: 'b', sourceLang: 'en', targetLang: 'zh', ts: base + 10, reviewCount: 0, favorite: true },
      { id: 'c', term: 'c', translation: 'c', sourceLang: 'en', targetLang: 'zh', ts: base + 20, reviewCount: 0, favorite: false },
    ];
    expect(sortVocabulary(list).map((v) => v.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('侧栏草稿', () => {
  beforeEach(async () => {
    await clearSidebarDraft();
  });

  it('写入后可读取，清除后为 undefined', async () => {
    expect(await loadSidebarDraft()).toBeUndefined();

    await saveSidebarDraft({ sourceText: 'Hello', translatedText: '你好' });
    const draft = await loadSidebarDraft();
    expect(draft?.sourceText).toBe('Hello');
    expect(draft?.translatedText).toBe('你好');
    expect(typeof draft?.ts).toBe('number');

    await clearSidebarDraft();
    expect(await loadSidebarDraft()).toBeUndefined();
  });
});
