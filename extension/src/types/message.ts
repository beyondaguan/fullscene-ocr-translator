/**
 * Native Messaging 请求/响应类型（与 Rust 端 fs-core/src/types.rs 同构）。
 *
 * 采用 serde `tag="type"` 标签联合，与 Rust 端完全一致：
 * - 请求：`Ping` / `Capture { target }` / `SelectCapture` / `Ocr { image_id }` / `Translate { text, src, dst }`
 * - 响应：`Pong` / `Error { message }` / `Captured { width, height, image_id }` /
 *         `OcrResult { lines }` / `Translation { text }`
 *
 * 注意：响应按发送顺序返回（host 单线程顺序处理），插件侧用 FIFO 队列关联，
 * 不再依赖 timestamp。
 */

/** OCR 单行结果（bbox 为 [x0, y0, x1, y1]） */
export interface OcrLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
}

/** 截图目标（多显示器支持） */
export type CaptureTarget =
  | { mode: 'Primary' }
  | { mode: 'Region'; x: number; y: number; w: number; h: number }
  | { mode: 'Monitor'; index: number }
  | { mode: 'All' }
  | { mode: 'Active' };

/** 请求消息（插件 → Rust 壳） */
export type NmRequest =
  | { type: 'Ping' }
  | { type: 'Capture'; target: CaptureTarget }
  | { type: 'SelectCapture' }
  | { type: 'Ocr'; image_id: string }
  | { type: 'Translate'; text: string; src: string; dst: string };

/** 响应消息（Rust 壳 → 插件） */
export type NmResponse =
  | { type: 'Pong' }
  | { type: 'Error'; message: string }
  | { type: 'Captured'; width: number; height: number; image_id: string }
  | { type: 'OcrResult'; lines: OcrLine[] }
  | { type: 'Translation'; text: string };

/** 类型守卫：是否为错误响应 */
export function isError(resp: NmResponse): resp is { type: 'Error'; message: string } {
  return resp.type === 'Error';
}