/**
 * Native Messaging 协议常量与线上契约（与 Rust 端 fs-core types.rs 对齐）。
 * 传输层：4 字节小端长度前缀 + UTF-8 JSON（见 crates/host/src/protocol.rs）。
 */

/** Native host 名（三处一致：注册表键名 / 本文件 / nm_host.json 的 name） */
export const NM_HOST = 'com.fullscene.ocr_translator';

/** 单帧最大长度（与 Rust 端 MAX_FRAME_SIZE 对齐，16 MiB） */
export const MAX_FRAME_SIZE = 16 * 1024 * 1024;

/** 请求类型白名单（与 types.rs NmRequest 变体一一对应） */
export const REQUEST_TYPES = ['Ping', 'Capture', 'SelectCapture', 'Ocr', 'Translate'] as const;

/** 响应类型白名单（与 types.rs NmResponse 变体一一对应） */
export const RESPONSE_TYPES = ['Pong', 'Error', 'Captured', 'OcrResult', 'Translation'] as const;