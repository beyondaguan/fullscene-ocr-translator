//! Native Messaging 协议（M5/M6）：4 字节小端长度前缀 + UTF-8 JSON。

use fs_core::error::{AppError, Result};
use fs_core::types::{NmRequest, NmResponse};
use std::io::{Read, Write};

/// 单帧最大长度（16 MiB）。超过即视为损坏/恶意对端，拒绝分配，避免 OOM。
const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;

pub fn read_message<R: Read>(r: &mut R) -> Result<NmRequest> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_FRAME_SIZE {
        return Err(AppError::FrameTooLarge(len));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}

pub fn write_message<W: Write>(w: &mut W, msg: &NmResponse) -> Result<()> {
    let body = serde_json::to_vec(msg)?;
    let len = (body.len() as u32).to_le_bytes();
    w.write_all(&len)?;
    w.write_all(&body)?;
    w.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fs_core::error::AppError;
    use fs_core::types::OcrLine;
    use std::io::Cursor;

    /// 按 NM 协议封帧：4 字节小端长度 + UTF-8 JSON
    fn frame(json: &str) -> Vec<u8> {
        let body = json.as_bytes();
        let mut out = (body.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn reads_ping_framed_message() {
        let mut cur = Cursor::new(frame(r#"{"type":"Ping"}"#));
        assert_eq!(read_message(&mut cur).unwrap(), NmRequest::Ping);
    }

    #[test]
    fn length_prefix_is_little_endian() {
        // oracle: {"type":"Ping"} 为 15 字节，小端编码 0F 00 00 00（大端会是 00 00 00 0F）
        let bytes = frame(r#"{"type":"Ping"}"#);
        assert_eq!(bytes.len() - 4, 15);
        assert_eq!(&bytes[..4], &[0x0f, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn reads_translate_with_all_fields() {
        let json = r#"{"type":"Translate","text":"hello","src":"en","dst":"zh"}"#;
        let mut cur = Cursor::new(frame(json));
        assert_eq!(
            read_message(&mut cur).unwrap(),
            NmRequest::Translate { text: "hello".into(), src: "en".into(), dst: "zh".into() }
        );
    }

    #[test]
    fn truncated_body_returns_io_error() {
        // 脏输入：声明 100 字节，实际只给 3 字节
        let mut v = (100u32).to_le_bytes().to_vec();
        v.extend_from_slice(b"abc");
        let mut cur = Cursor::new(v);
        assert!(matches!(read_message(&mut cur), Err(AppError::Io(_))));
    }

    #[test]
    fn malformed_json_returns_json_error() {
        let mut cur = Cursor::new(frame("{not json"));
        assert!(matches!(read_message(&mut cur), Err(AppError::Json(_))));
    }

    #[test]
    fn empty_body_returns_json_error() {
        // 脏输入：长度为 0，空字节无法反序列化为 NmRequest
        let mut cur = Cursor::new(frame(""));
        assert!(matches!(read_message(&mut cur), Err(AppError::Json(_))));
    }

    #[test]
    fn oversized_frame_rejected_before_allocation() {
        // 脏输入：声明 1 GiB 长度，远超 16 MiB 上限；应在分配 vec 前返回 Err（防 OOM）
        // oracle: read_exact(len_buf) 成功，但 len 超限立即报错，绝不分配 1 GiB 内存
        let v = (1024u32 * 1024 * 1024).to_le_bytes().to_vec();
        let mut cur = Cursor::new(v);
        match read_message(&mut cur) {
            Err(AppError::FrameTooLarge(n)) => assert_eq!(n, 1024 * 1024 * 1024),
            other => panic!("超大帧应返回 FrameTooLarge，实际: {other:?}"),
        }
    }

    #[test]
    fn write_then_read_round_trip() {
        let msg = NmResponse::OcrResult {
            lines: vec![OcrLine { text: "Hi".into(), confidence: 1.0, bbox: [0.0, 0.0, 1.0, 1.0] }],
        };
        let mut buf = Vec::new();
        write_message(&mut buf, &msg).unwrap();

        // oracle: 前 4 字节长度必须等于后续 body 的实际长度
        let declared = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        assert_eq!(declared, buf.len() - 4);

        let parsed: NmResponse = serde_json::from_slice(&buf[4..]).unwrap();
        assert_eq!(parsed, msg);
    }

    #[test]
    fn write_error_response_is_parseable() {
        let mut buf = Vec::new();
        write_message(&mut buf, &NmResponse::Error { message: "boom".into() }).unwrap();
        let parsed: NmResponse = serde_json::from_slice(&buf[4..]).unwrap();
        assert_eq!(parsed, NmResponse::Error { message: "boom".into() });
    }
}
