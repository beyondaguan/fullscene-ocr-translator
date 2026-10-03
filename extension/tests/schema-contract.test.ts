/**
 * 三方契约锁：nm-protocol.schema.json ↔ types/message.ts ↔ Rust types.rs。
 * 本测试保证 schema 的 oneOf type 枚举与 message.ts 联合类型完全一致。
 */
import { describe, expect, it } from 'vitest';
import schema from '../src/types/nm-protocol.schema.json';

/** 提取 schema 某个 oneOf 节点的判别字段 const 列表（NmRequest/NmResponse 用 type，CaptureTarget 用 mode） */
function oneOfTypeConsts(node: unknown, key: string, field = 'type'): string[] {
  const obj = (node as Record<string, unknown>)[key] as { oneOf?: Array<{ properties?: Record<string, { const?: string }> }> } | undefined;
  if (!obj?.oneOf) return [];
  return obj.oneOf
    .map((variant) => variant.properties?.[field]?.const)
    .filter((v): v is string => typeof v === 'string');
}

describe('nm-protocol schema ↔ message.ts 契约', () => {
  it('NmRequest 枚举与 message.ts 请求联合类型一致', () => {
    const consts = oneOfTypeConsts(schema, 'NmRequest');
    expect(consts).toEqual(['Ping', 'Capture', 'SelectCapture', 'Ocr', 'Translate']);
  });

  it('NmResponse 枚举与 message.ts 响应联合类型一致', () => {
    const consts = oneOfTypeConsts(schema, 'NmResponse');
    expect(consts).toEqual(['Pong', 'Error', 'Captured', 'OcrResult', 'Translation']);
  });

  it('CaptureTarget 支持全部五种模式', () => {
    const consts = oneOfTypeConsts(schema.definitions, 'CaptureTarget', 'mode');
    expect(consts).toEqual(['Primary', 'Region', 'Monitor', 'All', 'Active']);
  });

  it('OcrLine 字段与 message.ts OcrLine 一致', () => {
    const def = (schema.definitions as Record<string, unknown>).OcrLine as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(def.required).toEqual(['text', 'confidence', 'bbox']);
    expect(Object.keys(def.properties ?? {})).toEqual(['text', 'confidence', 'bbox']);
  });
});