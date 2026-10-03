/**
 * Markdown 日积累导出工具：把翻译历史按日分组生成 Markdown，支持单文件 / ZIP 打包。
 * 格式参考 WinOCR-Html 的日积累设计：按日期分文件，每条记录含时间、原文、译文。
 */

import type { HistoryItem } from './store';

/** 两位补零 */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 格式化为 YYYY-MM-DD */
export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 格式化为 MM-DD HH:mm */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 按日期分组（保持组内时间升序） */
export function groupByDate(records: HistoryItem[]): Record<string, HistoryItem[]> {
  const groups: Record<string, HistoryItem[]> = {};
  for (const r of records) {
    const k = fmtDate(r.ts);
    (groups[k] = groups[k] || []).push(r);
  }
  return groups;
}

/** 单组记录转 Markdown（时间 + 原文 + 译文 + 引擎） */
export function recordsToMarkdown(records: HistoryItem[]): string {
  let out = '';
  records
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : 1))
    .forEach((r) => {
      out += `## ${fmtDateTime(r.ts)}\n\n`;
      out += `**原文**: ${r.sourceText}\n\n`;
      out += `**译文**: ${r.translatedText}\n\n`;
      out += `*引擎*: ${r.engine} · ${r.sourceLang} → ${r.targetLang}\n\n`;
    });
  return out;
}

/** 全部记录转 Markdown（每日一个 # 标题，含 frontmatter） */
export function buildDailyMarkdown(records: HistoryItem[]): string {
  const groups = groupByDate(records);
  let md = '';
  Object.keys(groups)
    .sort()
    .forEach((date) => {
      md += `---\n\n# 全场景OCR翻译 ${date}\n\n${recordsToMarkdown(groups[date])}`;
    });
  return md;
}

/** 单个日期文件内容 */
export function dailyFileContent(date: string, records: HistoryItem[]): string {
  return `# 全场景OCR翻译 ${date}\n\n${recordsToMarkdown(records)}`;
}

// ---------------- 零依赖 ZIP（store，无压缩） ----------------

/** CRC32（ZIP 标准） */
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * 生成 ZIP Blob（store 模式，无压缩）。
 * files: [{ name: 'xxx.md', data: Uint8Array }]
 */
export function makeZip(files: Array<{ name: string; data: Uint8Array }>): Blob {
  const chunks: BlobPart[] = [];
  let offset = 0;
  const central: Uint8Array[] = [];
  const enc = (s: string) => new TextEncoder().encode(s);

  /** Uint8Array → BlobPart（复制 buffer 避免 SharedArrayBuffer 类型问题） */
  const toPart = (u: Uint8Array): BlobPart =>
    u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

  files.forEach((f) => {
    const name = enc(f.name);
    const data = f.data;
    const crc = crc32(data);
    const size = data.length;

    const local = new Uint8Array(30 + name.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    local.set(name, 30);
    chunks.push(toPart(local), toPart(data));

    const cen = new Uint8Array(46 + name.length);
    const cd = new DataView(cen.buffer);
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true);
    cd.setUint16(36, 0, true);
    cd.setUint32(38, offset, true);
    cd.setUint32(42, 0, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + data.length;
  });

  const cdStart = offset;
  let cdSize = 0;
  central.forEach((c) => {
    chunks.push(toPart(c));
    cdSize += c.length;
  });

  const end = new Uint8Array(22);
  const ed = new DataView(end.buffer);
  ed.setUint32(0, 0x06054b50, true);
  ed.setUint16(8, files.length, true);
  ed.setUint16(10, files.length, true);
  ed.setUint32(12, cdSize, true);
  ed.setUint32(16, cdStart, true);
  ed.setUint16(20, 0, true);
  chunks.push(toPart(end));

  return new Blob(chunks, { type: 'application/zip' });
}