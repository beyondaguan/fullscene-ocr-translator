//! OCR 引擎抽象（M6/M17）。
//!
//! - [`OcrEngine`]：统一 trait，便于替换与测试
//! - [`PlaceholderOcr`]：空实现，模型缺失或初始化失败时降级使用
//! - [`PpOcrV6`]：PP-OCRv6 真实推理，基于 `oar-ocr`（内部用 ONNX Runtime）

use crate::error::{AppError, Result};
use crate::types::{OcrLine, PixelFormat, RawImage};
use image::RgbImage;
use oar_ocr::core::config::OrtSessionConfig;
use oar_ocr::domain::tasks::TextDetectionConfig;
use oar_ocr::oarocr::ocr::{OAROCR, OAROCRBuilder};
use oar_ocr::processors::LimitType;

/// OCR 引擎抽象。要求 `Send + Sync` 以便跨线程（全局热键线程）共享同一引擎实例。
pub trait OcrEngine: Send + Sync {
    fn recognize(&self, image: &RawImage) -> Result<Vec<OcrLine>>;
}

/// 占位实现：不真正识别，返回空（模型未就绪时降级，保证壳进程不崩）
pub struct PlaceholderOcr;

impl OcrEngine for PlaceholderOcr {
    fn recognize(&self, _image: &RawImage) -> Result<Vec<OcrLine>> {
        Ok(Vec::new())
    }
}

/// PP-OCRv6 推理引擎（det + rec + 字典）
pub struct PpOcrV6 {
    inner: OAROCR,
}

impl PpOcrV6 {
    /// 用模型文件路径构建引擎。
    ///
    /// 模型目录与文件发现见 [`crate::ocr_models::load_models`]。
    pub fn new(det: &str, rec: &str, dict: &str) -> Result<Self> {
        // 多线程推理：ONNX Runtime 默认单线程，按逻辑核数配置 intra-op 线程提升多核利用率；
        // available_parallelism 失败时回落 4（常见桌面机的保守默认值）。
        let intra_threads =
            std::thread::available_parallelism().map_or(4, std::num::NonZeroUsize::get);
        let ort_cfg = OrtSessionConfig::new().with_intra_threads(intra_threads);
        let inner = OAROCRBuilder::new(det, rec, dict)
            .ort_session(ort_cfg)
            // 限边长取 PP-OCR 官方默认值：长边超过 960 才缩放，
            // 整屏截图（1080p/4K）提速明显；框选小图（长边 < 960）完全不受影响。
            .text_detection_config(TextDetectionConfig {
                limit_side_len: Some(960),
                limit_type: Some(LimitType::Max),
                ..Default::default()
            })
            .build()
            .map_err(|e| AppError::Ocr(format!("初始化 PP-OCRv6 失败: {e}")))?;
        Ok(Self { inner })
    }
}

impl OcrEngine for PpOcrV6 {
    fn recognize(&self, image: &RawImage) -> Result<Vec<OcrLine>> {
        let rgb = to_rgb_image(image)?;
        let results = self
            .inner
            .predict(vec![rgb])
            .map_err(|e| AppError::Ocr(format!("OCR 推理失败: {e}")))?;

        let first = match results.first() {
            Some(r) => r,
            None => return Ok(Vec::new()),
        };

        Ok(first
            .text_regions
            .iter()
            .map(|region| {
                let (x0, y0, x1, y1) = region.bounding_box.aabb();
                OcrLine {
                    text: region.text.as_deref().unwrap_or("").to_string(),
                    confidence: region.confidence.unwrap_or(0.0),
                    bbox: [x0, y0, x1, y1],
                }
            })
            .collect())
    }
}

/// 把 4 通道原始像素转成 `RgbImage`（丢弃 alpha，按 `format` 纠正通道顺序）。
pub fn to_rgb_image(image: &RawImage) -> Result<RgbImage> {
    if !image.has_expected_len() {
        return Err(AppError::Ocr(format!(
            "图像数据长度不匹配: {} 字节，期望 {}（{}x{}x4）",
            image.data.len(),
            image.pixel_count() * 4,
            image.width,
            image.height
        )));
    }

    let mut out = RgbImage::new(image.width, image.height);
    for (i, px) in out.pixels_mut().enumerate() {
        let o = i * 4;
        let (r, g, b) = match image.format {
            PixelFormat::Rgba => (image.data[o], image.data[o + 1], image.data[o + 2]),
            PixelFormat::Bgra => (image.data[o + 2], image.data[o + 1], image.data[o]),
        };
        *px = image::Rgb([r, g, b]);
    }
    Ok(out)
}

/// 构建 OCR 引擎（懒加载）。
///
/// - 模型就绪（`models/ppocrv6` 或用户配置目录）→ 返回真实 PP-OCRv6；
/// - 模型缺失 / 初始化失败 → 返回 [`PlaceholderOcr`]（占位，不报错）。
///
/// 供 `crates/gui`（主程序，常驻）与 `crates/host`（NM 桥，一次性进程）共用，
/// 避免各自复制「模型缺失降级」逻辑。
pub fn build_engine(dir: Option<&str>) -> Result<Box<dyn OcrEngine>> {
    let models = crate::ocr_models::load_models(dir)?;
    if !models.ready() {
        return Ok(Box::new(PlaceholderOcr));
    }
    match PpOcrV6::new(
        models.det.as_deref().unwrap_or_default(),
        models.rec.as_deref().unwrap_or_default(),
        models.keys.as_deref().unwrap_or_default(),
    ) {
        Ok(e) => Ok(Box::new(e)),
        Err(_) => Ok(Box::new(PlaceholderOcr)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_returns_empty() {
        let img = RawImage { width: 2, height: 2, data: vec![0; 16], format: PixelFormat::Rgba };
        assert_eq!(PlaceholderOcr.recognize(&img).unwrap().len(), 0);
    }

    #[test]
    fn rgb_conversion_keeps_channels() {
        // oracle: RGBA 输入按 R,G,B 顺序取前三通道，忽略 alpha
        let img = RawImage {
            width: 2,
            height: 1,
            data: vec![10, 20, 30, 255, 40, 50, 60, 255],
            format: PixelFormat::Rgba,
        };
        let rgb = to_rgb_image(&img).unwrap();
        assert_eq!(rgb.get_pixel(0, 0).0, [10, 20, 30]);
        assert_eq!(rgb.get_pixel(1, 0).0, [40, 50, 60]);
    }

    #[test]
    fn bgra_conversion_swaps_red_and_blue() {
        // oracle: BGRA 输入必须交换 R/B，否则截图会红蓝颠倒
        let img = RawImage {
            width: 1,
            height: 1,
            data: vec![10, 20, 30, 255], // B=10 G=20 R=30
            format: PixelFormat::Bgra,
        };
        let rgb = to_rgb_image(&img).unwrap();
        assert_eq!(rgb.get_pixel(0, 0).0, [30, 20, 10]);
    }

    #[test]
    fn mismatched_length_is_rejected() {
        // 脏输入：数据长度与 宽*高*4 不符 -> 报错而非越界静默
        let img = RawImage { width: 4, height: 4, data: vec![0; 10], format: PixelFormat::Rgba };
        assert!(to_rgb_image(&img).is_err());
    }

    #[test]
    fn zero_sized_image_has_expected_len() {
        let img = RawImage { width: 0, height: 0, data: Vec::new(), format: PixelFormat::Rgba };
        assert!(img.has_expected_len());
        assert_eq!(img.pixel_count(), 0);
    }

    /// 端到端：用真实 PP-OCRv6 模型识别官方测试图。
    ///
    /// 默认跳过（需加载 30MB 模型），手动执行：
    /// `cargo test -p fs-core -- --ignored --nocapture e2e_ppocrv6_recognizes_text`
    ///
    /// 模型与测试图都按**本文件所在 crate 根**定位（而非 CWD），这样从仓库根
    /// `cargo test` 与从 `crates/core` 内执行结果一致——`cargo test` 不保证 CWD。
    #[test]
    #[ignore = "需真实模型与测试图，手动跑：cargo test -p fs-core -- --ignored --nocapture e2e_ppocrv6_recognizes_text"]
    fn e2e_ppocrv6_recognizes_text() {
        let crate_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let model_dir = crate_root.join(crate::ocr_models::DEFAULT_MODEL_DIR);
        // 优先用 CWD 模型（开发态常见放仓库根 models/），否则回落 crate 内 models/。
        let models = {
            let cwd_set = crate::ocr_models::load_models(None).unwrap_or_default();
            if cwd_set.ready() {
                cwd_set
            } else {
                crate::ocr_models::load_models(Some(&model_dir.to_string_lossy())).expect("读取模型目录失败")
            }
        };
        if !models.ready() {
            panic!(
                "模型未就绪（需 det+rec+dict）。已尝试 CWD 与 {}；\
                 可运行 `bash scripts/fetch_ocr_models.sh` 下载",
                model_dir.display()
            );
        }
        let det = models.det.unwrap();
        let rec = models.rec.unwrap();
        let keys = models.keys.unwrap();

        let engine = PpOcrV6::new(&det, &rec, &keys).expect("构建 PP-OCRv6 引擎失败");

        let img = image::open(crate_root.join("tests-data/det_0.jpg")).expect("读取测试图失败");
        let rgba = img.to_rgba8();
        let raw = RawImage {
            width: rgba.width(),
            height: rgba.height(),
            data: rgba.into_raw(),
            format: PixelFormat::Rgba,
        };

        let lines = engine.recognize(&raw).expect("推理失败");
        eprintln!("\n识别到 {} 行：", lines.len());
        for l in &lines {
            eprintln!("  conf={:.3} bbox={:?} text={:?}", l.confidence, l.bbox, l.text);
        }

        assert!(!lines.is_empty(), "应至少识别出一行文本");
        assert!(
            lines.iter().any(|l| !l.text.trim().is_empty()),
            "至少一行文本非空"
        );
        // bbox 必须是有意义的区域：宽高非负且至少有一个非退化框
        assert!(
            lines.iter().any(|l| l.bbox[2] > l.bbox[0] && l.bbox[3] > l.bbox[1]),
            "应至少有一个非退化的文本框"
        );
    }
}
