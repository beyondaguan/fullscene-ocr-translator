//! 核心数据类型（M6/M17）。

use serde::{Deserialize, Serialize};

/// 原始像素通道排列。
///
/// 必须显式区分：Windows GDI 截图得到的是 **BGRA**，若按 RGBA 解释会出现红蓝互换。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    /// R, G, B, A
    Rgba,
    /// B, G, R, A（Windows GDI / BitBlt 原生顺序）
    Bgra,
}

/// 原始图像（每像素 4 字节，按 `format` 解释通道顺序）
#[derive(Debug, Clone)]
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    pub format: PixelFormat,
}

impl RawImage {
    /// 像素总数（width * height）
    pub fn pixel_count(&self) -> usize {
        self.width as usize * self.height as usize
    }

    /// 按 4 字节/像素校验数据长度是否正确
    pub fn has_expected_len(&self) -> bool {
        self.data.len() == self.pixel_count() * 4
    }
}

/// OCR 单行结果（bbox 为 [x0, y0, x1, y1]）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OcrLine {
    pub text: String,
    pub confidence: f32,
    pub bbox: [f32; 4],
}

/// 截图目标（多显示器支持）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode")]
pub enum CaptureTarget {
    /// 主显示器全屏
    Primary,
    /// 主显示器指定区域（虚拟屏坐标）
    Region { x: i32, y: i32, w: i32, h: i32 },
    /// 指定索引显示器（0-based）
    Monitor { index: usize },
    /// 全部显示器合并为一张虚拟屏大图
    All,
    /// 光标当前所在显示器（运行时由 host 解析，多显示器热键默认）
    Active,
}

/// Native Messaging 请求（插件 -> 本地壳）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum NmRequest {
    Capture { target: CaptureTarget },
    /// 弹交互式框选遮罩，用户拖出区域后截图（浏览器扩展触发框选翻译）
    SelectCapture,
    Ocr { image_id: String },
    Translate { text: String, src: String, dst: String },
    Ping,
}

/// Native Messaging 响应（本地壳 -> 插件）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum NmResponse {
    Pong,
    Error { message: String },
    /// 截图完成；`image_id` 供随后 `Ocr` 请求按 id 取回图像数据
    Captured { width: u32, height: u32, image_id: String },
    OcrResult { lines: Vec<OcrLine> },
    Translation { text: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_serializes_to_tagged_json() {
        // oracle: 内部标签 serde(tag="type") 产生 {"type":"Ping"}
        assert_eq!(serde_json::to_string(&NmRequest::Ping).unwrap(), r#"{"type":"Ping"}"#);
    }

    #[test]
    fn capture_primary_serializes_to_tagged_json() {
        // oracle: 主显示器截图序列化为 {"type":"Capture","target":{"mode":"Primary"}}
        let json = serde_json::to_string(&NmRequest::Capture {
            target: CaptureTarget::Primary,
        })
        .unwrap();
        assert_eq!(json, r#"{"type":"Capture","target":{"mode":"Primary"}}"#);
    }

    #[test]
    fn capture_target_region_monitor_all_round_trip() {
        // oracle: 三种非主屏目标均可正确序列化往返
        let region = NmRequest::Capture {
            target: CaptureTarget::Region { x: 10, y: 20, w: 300, h: 200 },
        };
        let monitor = NmRequest::Capture {
            target: CaptureTarget::Monitor { index: 1 },
        };
        let all = NmRequest::Capture {
            target: CaptureTarget::All,
        };
        for req in [region, monitor, all] {
            let json = serde_json::to_string(&req).unwrap();
            assert_eq!(serde_json::from_str::<NmRequest>(&json).unwrap(), req);
        }
    }

    #[test]
    fn capture_target_monitor_index_preserved() {
        // oracle: Monitor 目标必须保留 index
        let req = NmRequest::Capture {
            target: CaptureTarget::Monitor { index: 2 },
        };
        let json = serde_json::to_string(&req).unwrap();
        assert_eq!(
            json,
            r#"{"type":"Capture","target":{"mode":"Monitor","index":2}}"#
        );
    }

    #[test]
    fn capture_target_active_round_trip() {
        // oracle: Active 目标序列化往返保持，且 wire 形如 {"mode":"Active"}
        let req = NmRequest::Capture {
            target: CaptureTarget::Active,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert_eq!(json, r#"{"type":"Capture","target":{"mode":"Active"}}"#);
        assert_eq!(serde_json::from_str::<NmRequest>(&json).unwrap(), req);
    }

    #[test]
    fn captured_response_includes_image_id() {
        // oracle: Captured 响应必须携带 image_id，供后续 Ocr 请求按 id 取图
        let resp = NmResponse::Captured { width: 1920, height: 1080, image_id: "cap-1".into() };
        let json = serde_json::to_string(&resp).unwrap();
        assert_eq!(
            json,
            r#"{"type":"Captured","width":1920,"height":1080,"image_id":"cap-1"}"#
        );
        let back: NmResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(back, resp);
    }

    #[test]
    fn translate_round_trip() {
        let req = NmRequest::Translate { text: "hi".into(), src: "en".into(), dst: "zh".into() };
        let json = serde_json::to_string(&req).unwrap();
        assert_eq!(serde_json::from_str::<NmRequest>(&json).unwrap(), req);
    }

    #[test]
    fn ocr_result_round_trip_preserves_lines_and_bbox() {
        let resp = NmResponse::OcrResult {
            lines: vec![
                OcrLine { text: "Hello".into(), confidence: 0.98, bbox: [1.0, 2.0, 3.0, 4.0] },
                OcrLine { text: "世界".into(), confidence: 0.5, bbox: [0.0, 0.0, 10.5, 20.25] },
            ],
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert_eq!(serde_json::from_str::<NmResponse>(&json).unwrap(), resp);
    }

    #[test]
    fn unknown_type_is_rejected() {
        // 脏输入：合法 JSON 但 type 未定义 -> 必须报错而非静默降级
        assert!(serde_json::from_str::<NmRequest>(r#"{"type":"Nope"}"#).is_err());
    }

    #[test]
    fn missing_payload_field_is_rejected() {
        // 脏输入：缺字段 -> 报错
        assert!(serde_json::from_str::<NmRequest>(r#"{"type":"Ocr"}"#).is_err());
    }

    /// 提取 schema 某个 oneOf 节点的 `type` const 列表（按出现顺序）
    fn oneof_type_consts(v: &serde_json::Value, key: &str) -> Vec<String> {
        v.get(key)
            .and_then(|n| n.get("oneOf"))
            .and_then(|o| o.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| {
                        x.get("properties")
                            .and_then(|p| p.get("type"))
                            .and_then(|t| t.get("const"))
                            .and_then(|c| c.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn schema_oneof_matches_canonical_variants() {
        // 三方可锁：本测试把 nm-protocol.schema.json 的 oneOf 枚举与 types.rs 真源的
        // 变体快照对表，防止"新增变体忘登记进 schema"的漂移（SelectCapture 漏登记曾发生）。
        // 配合 browser-extension/tests/schema-contract.test.ts（schema ↔ message.ts）形成闭环。
        let manifest = env!("CARGO_MANIFEST_DIR");
        let schema_path = std::path::Path::new(manifest)
            .join("../../extension/src/types/nm-protocol.schema.json");
        let text = std::fs::read_to_string(&schema_path)
            .expect("monorepo 布局下 nm-protocol.schema.json 必须可读");
        let v: serde_json::Value = serde_json::from_str(&text).expect("schema 必须是合法 JSON");

        let canonical_request = ["Ping", "Capture", "SelectCapture", "Ocr", "Translate"];
        let canonical_response = ["Pong", "Error", "Captured", "OcrResult", "Translation"];

        assert_eq!(
            oneof_type_consts(&v, "NmRequest"),
            canonical_request.iter().map(|s| s.to_string()).collect::<Vec<_>>()
        );
        assert_eq!(
            oneof_type_consts(&v, "NmResponse"),
            canonical_response.iter().map(|s| s.to_string()).collect::<Vec<_>>()
        );
    }
}
