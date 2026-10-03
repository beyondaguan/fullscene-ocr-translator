//! OCR 模型管理（M6/M17）：模型路径解析与可用性检测。
//!
//! 模型文件需预先下载到模型目录（默认 `models/ppocrv6`），本模块只负责
//! 发现与校验，不负责下载。参见 `docs/ocr-models.md`。

use crate::error::{AppError, Result};
use std::path::Path;

/// 默认模型目录（相对工作目录）
pub const DEFAULT_MODEL_DIR: &str = "models/ppocrv6";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct OcrModelSet {
    /// 检测模型（det）
    pub det: Option<String>,
    /// 识别模型（rec）
    pub rec: Option<String>,
    /// 字典（keys）
    pub keys: Option<String>,
}

impl OcrModelSet {
    /// det、rec、字典三者齐备才算可用。
    ///
    /// 字典不是可选项：`OAROCRBuilder::new` 的 `character_dict_path` 是必填参数，
    /// 缺字典无法构建识别器，因此缺任一即降级为占位实现。
    pub fn ready(&self) -> bool {
        self.det.is_some() && self.rec.is_some() && self.keys.is_some()
    }
}

/// 扫描给定目录，按文件名关键字匹配 det/rec/dict。目录不存在返回空集合（不报错）。
fn scan_model_dir(path: &Path) -> Result<OcrModelSet> {
    if !path.is_dir() {
        return Ok(OcrModelSet::default());
    }

    let mut set = OcrModelSet::default();
    for entry in std::fs::read_dir(path).map_err(AppError::Io)? {
        let entry = entry.map_err(AppError::Io)?;
        let name = entry.file_name().to_string_lossy().to_lowercase();
        let abs = entry.path().to_string_lossy().to_string();

        if name.ends_with(".onnx") && name.contains("det") {
            set.det = Some(abs);
        } else if name.ends_with(".onnx") && name.contains("rec") {
            set.rec = Some(abs);
        } else if name.ends_with(".txt") && (name.contains("dict") || name.contains("keys")) {
            set.keys = Some(abs);
        }
    }
    Ok(set)
}

/// 从模型目录解析 PP-OCRv6 模型集合。
///
/// - `dir` 为 `Some` 时按用户给定路径（绝对或相对 CWD）解析；
/// - `dir` 为 `None` 时使用 [`DEFAULT_MODEL_DIR`]，解析顺序：
///   1) exe 自身目录下的 `models/ppocrv6`（部署态：浏览器以 NM 拉起 host 时 CWD 是浏览器/配置目录，
///      非 exe 目录，必须优先按 exe 自身目录定位，否则取不到模型导致 OCR 静默降级）；
///   2) 回退相对 CWD 的 `models/ppocrv6`（开发/测试态，`cargo test` 时 CWD 即 crate 根）。
pub fn load_models(dir: Option<&str>) -> Result<OcrModelSet> {
    match dir {
        Some(d) => scan_model_dir(Path::new(d)),
        None => {
            if let Ok(exe) = std::env::current_exe() {
                if let Some(parent) = exe.parent() {
                    let exe_rel = parent.join(DEFAULT_MODEL_DIR);
                    if exe_rel.is_dir() {
                        return scan_model_dir(&exe_rel);
                    }
                }
            }
            scan_model_dir(Path::new(DEFAULT_MODEL_DIR))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 建一个独立的临时目录（用进程 id + 序号避免并发冲突），返回其路径
    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("qcjocr_models_{}_{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn touch(dir: &std::path::Path, name: &str) {
        fs::write(dir.join(name), b"x").unwrap();
    }

    #[test]
    fn missing_dir_yields_empty_set_without_error() {
        // oracle: 目录不存在是常见情况（模型未下载），必须降级而非报错
        let set = load_models(Some("definitely/not/here")).unwrap();
        assert_eq!(set, OcrModelSet::default());
        assert!(!set.ready());
    }

    #[test]
    fn empty_dir_yields_empty_set() {
        let dir = tmp_dir("empty");
        let set = load_models(Some(&dir.to_string_lossy())).unwrap();
        assert_eq!(set, OcrModelSet::default());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn full_dir_is_ready() {
        // oracle: det + rec 齐备才算可用
        let dir = tmp_dir("full");
        touch(&dir, "pp-ocrv6_small_det.onnx");
        touch(&dir, "pp-ocrv6_small_rec.onnx");
        touch(&dir, "ppocrv6_dict.txt");

        let set = load_models(Some(&dir.to_string_lossy())).unwrap();
        assert!(set.ready());
        assert!(set.det.as_deref().unwrap().contains("pp-ocrv6_small_det.onnx"));
        assert!(set.rec.as_deref().unwrap().contains("pp-ocrv6_small_rec.onnx"));
        assert!(set.keys.as_deref().unwrap().contains("ppocrv6_dict.txt"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn det_without_rec_is_not_ready() {
        // 脏输入：只下了检测模型 -> 不可用，但也不报错
        let dir = tmp_dir("detonly");
        touch(&dir, "pp-ocrv6_small_det.onnx");

        let set = load_models(Some(&dir.to_string_lossy())).unwrap();
        assert!(set.det.is_some());
        assert!(set.rec.is_none());
        assert!(!set.ready());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tier_switch_requires_no_code_change() {
        // oracle: 按关键字匹配，换成 tiny/medium 档位仍能被发现
        let dir = tmp_dir("tiny");
        touch(&dir, "pp-ocrv6_tiny_det.onnx");
        touch(&dir, "pp-ocrv6_tiny_rec.onnx");
        touch(&dir, "ppocrv6_tiny_dict.txt");

        let set = load_models(Some(&dir.to_string_lossy())).unwrap();
        assert!(set.ready());
        assert!(set.det.as_deref().unwrap().contains("tiny_det"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unrelated_files_are_ignored() {
        // 脏输入：目录里混入无关文件不应被误认成模型
        let dir = tmp_dir("noise");
        touch(&dir, "README.md");
        touch(&dir, "config.json");

        let set = load_models(Some(&dir.to_string_lossy())).unwrap();
        assert_eq!(set, OcrModelSet::default());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn real_model_dir_is_discoverable() {
        // 集成校验：仓库内真实下载的 small 档模型应被识别（CI 未下载时跳过）
        let dir = Path::new(DEFAULT_MODEL_DIR);
        if !dir.is_dir() {
            eprintln!("skip: {} 不存在（模型未下载）", DEFAULT_MODEL_DIR);
            return;
        }
        let set = load_models(None).unwrap();
        assert!(set.ready(), "已下载模型的目录应被识别为可用");
        assert!(set.keys.is_some(), "字典应一并被发现");
    }
}
