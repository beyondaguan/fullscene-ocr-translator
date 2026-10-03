/**
 * 翻译请求缓存层（IndexedDB）：相同文本+语言对不重复请求。
 * 键 = hash(text|src|dst)，值 = TranslationResult，带时间戳用于淘汰。
 * IndexedDB 不可用时降级为无缓存（get 返回 undefined，set/prune 静默跳过）。
 */
import type { TranslationResult } from '../types/engine';

const DB_NAME = 'fullscene-translation-cache';
const DB_VERSION = 1;
const STORE = 'cache';
const MAX_ROWS = 500;

export interface CacheRow {
  key: string;
  value: TranslationResult;
  ts: number;
}

/** 生成缓存键：text + src + dst 拼接后取简单 hash */
export function makeKey(text: string, src: string, dst: string): string {
  const raw = `${text}|${src}|${dst}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  return `c_${hash.toString(36)}_${raw.length}`;
}

/** 取 IndexedDB 环境；不可用时返回 undefined（降级为无缓存） */
function idbEnv(): IDBFactory | undefined {
  return globalThis.indexedDB;
}

/** 打开数据库；IndexedDB 不可用时返回 undefined */
function openDb(): Promise<IDBDatabase | undefined> {
  const factory = idbEnv();
  if (!factory) return Promise.resolve(undefined);

  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开缓存数据库失败'));
  });
}

/** 读缓存；未命中返回 undefined；IndexedDB 不可用时也返回 undefined */
export async function get(key: string): Promise<TranslationResult | undefined> {
  try {
    const db = await openDb();
    if (!db) return undefined;
    const row = await request<CacheRow | undefined>(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
    return row?.value;
  } catch {
    return undefined;
  }
}

/** 写缓存；IndexedDB 不可用时静默跳过 */
export async function set(key: string, value: TranslationResult): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key, value, ts: Date.now() });
    await txDone(tx);
  } catch {
    // 缓存不可用时不阻塞翻译
  }
}

/** 超量淘汰：按 ts 升序删除最旧的行，直到 <= max */
export async function prune(max: number = MAX_ROWS): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const rows = await request<CacheRow[]>(store.getAll() as IDBRequest<CacheRow[]>);
    if (rows.length <= max) return;

    // 按 ts 升序排序，删除最旧的 (rows.length - max) 条
    const sorted = [...rows].sort((a, b) => a.ts - b.ts);
    const stale = sorted.slice(0, rows.length - max);
    for (const row of stale) store.delete(row.key);
    await txDone(tx);
  } catch {
    // 忽略
  }
}

/** 缓存层封装（供 engine-router 使用） */
export const cache = { get, set, makeKey, prune };

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('事务中止'));
  });
}