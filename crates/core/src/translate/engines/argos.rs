//! Argos 离线翻译引擎（ct2rs 纯 Rust，CTranslate2）。
//!
//! 语言包目录约定（与 Argos 桌面安装目录一致，可直接把 Argos 安装目录
//! `packages/translate-*` 复制为语言包）：
//!
//! ```text
//! {argos_models_dir}/
//! └── {from}_{to}/               # 如 en_zh
//!     └── {version}/             # 如 1_9 / 1.9（扫描该层子目录取字典序最大）
//!         ├── model/
//!         │   ├── config.json
//!         │   └── model.bin
//!         │   └── shared_vocabulary.json   # 可选，共享词表佐证
//!         └── sentencepiece.model           # 源/目标共用分词器
//! ```
//!
//! ## 单 spm 复用
//!
//! Argos 语言包只有一个 `sentencepiece.model`，源/目标语言共用同一个
//! SentencePiece 模型（OpenNMT 共享词表模型，`shared_vocabulary.json` 佐证）。
//! `ct2rs` 的 [`SpTokenizer::from_file`] 接受两个路径参数但**不校验两者是否相同**，
//! 因此 `from_file(spm, spm)` 传同一路径两次即可，无需复制文件。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ct2rs::tokenizers::sentencepiece::Tokenizer as SpTokenizer;
use ct2rs::{Config as Ct2Config, TranslationOptions, Translator as Ct2Translator};

use crate::config::Config;
use crate::error::{AppError, Result};
use crate::translate::base::TranslateBase;
use crate::translate::registry::split_for_translation;

/// 语言对键：`{src}_{dst}`，如 `("en", "zh")`。
type LangPair = (String, String);

/// 懒加载缓存的键值：一个源→目标语言对对应一个 CT2 翻译器实例。
type CachedTranslator = Arc<Ct2Translator<SpTokenizer>>;

/// Argos 引擎：目录解析 + 懒加载缓存 + 批量翻译。
pub struct ArgosEngine {
    models_dir: PathBuf,
    cache: Mutex<HashMap<LangPair, CachedTranslator>>,
}

impl ArgosEngine {
    /// 由配置构造。`argos_models_dir` 缺省时用 `%APPDATA%/FullSceneOCR/argos/models`
    /// （与 [`crate::config::config_path`] 同基目录）。
    pub fn from_config(cfg: &Config) -> Self {
        let dir = cfg
            .argos_models_dir
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(default_models_dir);
        Self {
            models_dir: dir,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// 扫描 `{models_dir}/{src}_{dst}/` 下所有含 `model/` 子目录的版本目录，
    /// 返回**字典序最大**者。
    ///
    /// Argos 版本号 `1_9` / `1.9` 的字典序与数值序基本一致；多版本边界（如
    /// 同时存在 `9` 与 `10`）见 `docs/argos-integration-design.md` §八待明确事项。
    fn resolve_version_dir(&self, src: &str, dst: &str) -> Result<PathBuf> {
        let pair_dir = self.models_dir.join(format!("{src}_{dst}"));
        if !pair_dir.is_dir() {
            return Err(AppError::Translate(format!(
                "Argos 未找到语言包目录 {}（请在设置中配置模型目录或放置语言包）",
                pair_dir.display()
            )));
        }
        let mut versions: Vec<PathBuf> = Vec::new();
        for entry in std::fs::read_dir(&pair_dir).map_err(|e| {
            AppError::Translate(format!(
                "Argos 读取语言包目录 {} 失败: {e}",
                pair_dir.display()
            ))
        })? {
            let entry = entry.map_err(|e| {
                AppError::Translate(format!(
                    "Argos 读取语言包目录 {} 失败: {e}",
                    pair_dir.display()
                ))
            })?;
            let p = entry.path();
            if p.is_dir() && p.join("model").is_dir() {
                versions.push(p);
            }
        }
        versions.sort();
        versions.last().cloned().ok_or_else(|| {
            AppError::Translate(format!(
                "Argos 语言包目录 {} 下没有含 model/ 的版本子目录",
                pair_dir.display()
            ))
        })
    }

    /// 解析 `{models_dir}/{src}_{dst}/{version}/model`，返回 model 目录路径。
    fn resolve_model_dir(&self, src: &str, dst: &str) -> Result<PathBuf> {
        self.resolve_version_dir(src, dst).map(|v| v.join("model"))
    }

    /// 返回 `{version}/sentencepiece.model`（与 `model/` 平级）。
    fn spm_path(&self, src: &str, dst: &str) -> Result<PathBuf> {
        self.resolve_version_dir(src, dst)
            .map(|v| v.join("sentencepiece.model"))
    }

    /// 懒加载 + Arc 缓存：key=(src,dst)。首次加载耗时长（CTranslate2 模型载入数秒），
    /// 之后 clone Arc 释放锁再推理，避免每次翻译重建模型。
    fn load_translator(&self, src: &str, dst: &str) -> Result<Arc<Ct2Translator<SpTokenizer>>> {
        let key = (src.to_string(), dst.to_string());
        if let Some(t) = self.cache.lock().unwrap().get(&key) {
            return Ok(Arc::clone(t));
        }
        let model_dir = self.resolve_model_dir(src, dst)?;
        let spm = self.spm_path(src, dst)?;
        let tokenizer = SpTokenizer::from_file(&spm, &spm).map_err(|e| {
            AppError::Translate(format!(
                "Argos 加载分词器 {} 失败: {e}",
                spm.display()
            ))
        })?;
        let translator = Ct2Translator::with_tokenizer(&model_dir, tokenizer, &Ct2Config::default())
            .map_err(|e| {
                AppError::Translate(format!(
                    "Argos 加载模型 {} 失败: {e}",
                    model_dir.display()
                ))
            })?;
        let arc = Arc::new(translator);
        self.cache.lock().unwrap().insert(key, Arc::clone(&arc));
        Ok(arc)
    }
}

impl TranslateBase for ArgosEngine {
    fn id(&self) -> &'static str {
        "argos"
    }

    fn label(&self) -> &'static str {
        "Argos 离线翻译"
    }

    /// 就绪判定（零网络开销）：`models_dir` 存在且含至少一个语言包子目录。
    ///
    /// `TranslateBase::available()` 没有语言对参数，无法在此判断具体语言对；
    /// 缺失具体语言对在 `translate()` 内快速失败，由降级链兜底。
    fn available(&self) -> bool {
        if !self.models_dir.is_dir() {
            return false;
        }
        std::fs::read_dir(&self.models_dir)
            .map(|rd| rd.filter_map(|e| e.ok()).any(|e| e.path().is_dir()))
            .unwrap_or(false)
    }

    /// 覆写：Argos 不做自动检测，且源=目标无意义（直接返回原文）。
    fn supports(&self, src: &str, dst: &str) -> bool {
        src != "auto" && src != dst
    }

    /// CTranslate2 解码长度 ~512 token 的保守字符上限；CJK 1 字符 ≈ 1~2 token。
    fn max_chars(&self) -> usize {
        1000
    }

    fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String> {
        let src_norm = src.trim().to_ascii_lowercase();
        let dst_norm = dst.trim().to_ascii_lowercase();

        if src_norm == "auto" {
            return Err(AppError::Translate(
                "Argos 离线翻译不支持自动检测源语言（auto），请明确选择源语言".into(),
            ));
        }
        if src_norm == dst_norm {
            // 源=目标：直接返回原文，避免无意义推理（与 MyMemory 行为一致）。
            return Ok(text.to_string());
        }

        let translator = self.load_translator(&src_norm, &dst_norm)?;
        let chunks = split_for_translation(text, self.max_chars());
        // 分片结果**一次** translate_batch 批量翻译（而非逐片串行），再按序 join。
        let sources: Vec<&str> = chunks.iter().map(String::as_str).collect();
        let results = translator
            .translate_batch(&sources, &TranslationOptions::default(), None)
            .map_err(|e| AppError::Translate(format!("Argos 翻译失败: {e}")))?;
        let out: Vec<String> = results
            .into_iter()
            .map(|(t, _score)| detokenize(&t))
            .collect();
        Ok(out.join("\n"))
    }
}

/// 默认模型目录：`%APPDATA%/FullSceneOCR/argos/models`。
fn default_models_dir() -> PathBuf {
    dirs::config_dir()
        .map(|base| base.join("FullSceneOCR").join("argos").join("models"))
        .unwrap_or_else(|| PathBuf::from("argos/models"))
}

/// SentencePiece 的空格标记（LOWER ONE EIGHTH BLOCK，U+2581）。
const SPM_SPACE: char = '\u{2581}';

/// 把 SentencePiece 词片序列还原为可读文本。
///
/// ## 为什么需要
///
/// `ct2rs` 的 [`SpTokenizer::decode`] 内部走 `sentencepiece::decode_pieces`，
/// 它只是把词片**原样拼接**，不执行 SentencePiece 官方的空白归一化，
/// 于是空格标记 `▁`(U+2581) 原样漏进译文：
///
/// ```text
/// 词片: ["▁Patients", "▁need", "▁two", "▁weeks", "▁off", "."]
/// 期望: "Patients need two weeks off."
/// 实际: "▁Patients▁need▁two▁weeks▁off."
/// ```
///
/// 中文目标侧不产生 `▁` 词片，故该缺陷只在英文等空格分词的目标语言暴露
/// （`en→zh` 正常、`zh→en` 出现 `▁`）。修复放在本侧而非改第三方 crate，
/// 与 SentencePiece 官方 `Decode` 的 `nmt` 空白归一化行为对齐：
/// `▁`→空格、折叠连续空格、去掉首尾空白。
fn detokenize(raw: &str) -> String {
    if !raw.contains(SPM_SPACE) {
        return raw.to_string();
    }
    let replaced = raw.replace(SPM_SPACE, " ");
    let mut out = String::with_capacity(replaced.len());
    let mut pending_space = false; // 首部空格直接丢弃
    for ch in replaced.chars() {
        if ch == ' ' {
            pending_space = true;
            continue;
        }
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        out.push(ch);
        pending_space = false;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// 创建一次性的临时目录（测试进程唯一），避免并发测试互相干扰。
    fn temp_dir(tag: &str) -> PathBuf {
        let unique = format!(
            "argos_test_{}_{}_{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        dir
    }

    /// 构造一个含两个版本的语言包目录树，返回 models_dir。
    fn make_lang_pack(root: &Path, versions: &[&str]) -> PathBuf {
        let models = root.join("models");
        for v in versions {
            let model_dir = models.join("en_zh").join(v).join("model");
            std::fs::create_dir_all(&model_dir).expect("创建 model 目录失败");
            let spm = models.join("en_zh").join(v).join("sentencepiece.model");
            std::fs::write(&spm, b"fake spm").expect("写 spm 文件失败");
        }
        models
    }

    #[test]
    fn resolve_model_dir_picks_largest_version() {
        // oracle: 多个版本并存时取字典序最大的版本目录下的 model/
        let root = temp_dir("versions");
        let models = make_lang_pack(&root, &["1_8", "1_9"]);
        let engine = ArgosEngine {
            models_dir: models.clone(),
            cache: Mutex::new(HashMap::new()),
        };
        let model_dir = engine.resolve_model_dir("en", "zh").unwrap();
        assert_eq!(model_dir, models.join("en_zh").join("1_9").join("model"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_model_dir_errors_when_pair_missing() {
        // oracle: 语言对目录不存在时返回明确 Translate 错误（供降级链识别）
        let root = temp_dir("missing_pair");
        let engine = ArgosEngine {
            models_dir: root.join("models"),
            cache: Mutex::new(HashMap::new()),
        };
        let err = engine.resolve_model_dir("en", "ja").unwrap_err();
        assert!(err.to_string().contains("未找到语言包目录"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn spm_path_reuses_single_sentencepiece() {
        // oracle: spm 路径 = {version}/sentencepiece.model，与 model/ 平级；
        // load_translator 的 from_file(spm, spm) 会复用同一路径（单 spm 模型）
        let root = temp_dir("spm");
        let models = make_lang_pack(&root, &["1_9"]);
        let engine = ArgosEngine {
            models_dir: models.clone(),
            cache: Mutex::new(HashMap::new()),
        };
        let spm = engine.spm_path("en", "zh").unwrap();
        assert_eq!(spm, models.join("en_zh").join("1_9").join("sentencepiece.model"));
        // 与 model_dir 平级（父目录相同）
        assert_eq!(
            spm.parent().unwrap(),
            engine.resolve_model_dir("en", "zh").unwrap().parent().unwrap()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn available_requires_language_packs() {
        // oracle: available() = models_dir 存在且含至少一个语言包子目录（零网络开销）
        let root = temp_dir("available");
        let engine_empty = ArgosEngine {
            models_dir: root.join("models"),
            cache: Mutex::new(HashMap::new()),
        };
        assert!(!engine_empty.available(), "目录不存在时应不可用");

        std::fs::create_dir_all(&root.join("models")).expect("创建 models 失败");
        assert!(!engine_empty.available(), "空目录应不可用");

        std::fs::create_dir_all(&root.join("models").join("en_zh")).expect("创建语言包失败");
        assert!(engine_empty.available(), "含语言包子目录时应可用");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn from_config_uses_default_models_dir_when_unset() {
        // oracle: 未配置 argos_models_dir 时使用 %APPDATA%/FullSceneOCR/argos/models
        let engine = ArgosEngine::from_config(&Config::default());
        let expected = dirs::config_dir()
            .map(|b| b.join("FullSceneOCR").join("argos").join("models"))
            .unwrap_or_else(|| PathBuf::from("argos/models"));
        assert_eq!(engine.models_dir, expected);
    }

    #[test]
    fn from_config_honors_configured_models_dir() {
        let cfg = Config {
            argos_models_dir: Some("D:/argos/models".into()),
            ..Default::default()
        };
        let engine = ArgosEngine::from_config(&cfg);
        assert_eq!(engine.models_dir, PathBuf::from("D:/argos/models"));
    }

    #[test]
    fn translate_rejects_auto_without_loading() {
        // oracle: src=="auto" 直接报错（第一版不做自动检测），不触碰模型目录
        let root = temp_dir("auto");
        let engine = ArgosEngine {
            models_dir: root.join("models"),
            cache: Mutex::new(HashMap::new()),
        };
        let err = engine.translate("hello", "auto", "zh").unwrap_err();
        assert!(err.to_string().contains("不支持自动检测"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn translate_returns_original_when_src_eq_dst() {
        // oracle: 源=目标直接返回原文，避免无意义推理
        let root = temp_dir("same");
        let engine = ArgosEngine {
            models_dir: root.join("models"),
            cache: Mutex::new(HashMap::new()),
        };
        assert_eq!(engine.translate("hello", "en", "EN").unwrap(), "hello");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn supports_semantics() {
        let engine = ArgosEngine {
            models_dir: PathBuf::from("unused"),
            cache: Mutex::new(HashMap::new()),
        };
        assert!(!engine.supports("auto", "zh"), "auto 不支持");
        assert!(!engine.supports("en", "en"), "同语言对不支持");
        assert!(engine.supports("en", "zh"), "正常语言对支持");
    }

    #[test]
    fn detokenize_restores_spm_space_marks() {
        // oracle: ▁(U+2581) 还原为空格，且不产生首部空格
        assert_eq!(
            detokenize("\u{2581}Patients\u{2581}need\u{2581}two\u{2581}weeks\u{2581}off."),
            "Patients need two weeks off."
        );
        // 词片拼接产生的连续/首尾空格被折叠
        assert_eq!(detokenize("\u{2581}Hello\u{2581}\u{2581}world\u{2581}"), "Hello world");
        // 纯中文（无 ▁）原样返回，不做任何改写
        assert_eq!(detokenize("病人应该休息两周。"), "病人应该休息两周。");
        // 空串安全
        assert_eq!(detokenize(""), "");
    }

    /// 端到端真实翻译（需本地存在 Argos 语言包，故默认 `#[ignore]`）。
    ///
    /// 跑法：`cargo test -p fs-core argos::tests::real -- --ignored --nocapture`
    /// 前置：`%APPDATA%\FullSceneOCR\argos\models\{en_zh,zh_en}\*` 已放置语言包。
    #[test]
    #[ignore = "需要本地 Argos 语言包（约 160MB），不进默认门禁"]
    fn real_end_to_end_translation() {
        let engine = ArgosEngine::from_config(&Config::default());
        assert!(engine.available(), "默认模型目录应可用");

        // en -> zh
        let zh = engine
            .translate("The patient should rest for two weeks.", "en", "zh")
            .expect("en->zh 翻译失败");
        println!("[en->zh] {zh}");
        assert!(!zh.trim().is_empty(), "译文不应为空");
        assert_ne!(zh.trim(), "The patient should rest for two weeks.", "应产出译文");

        // zh -> en：目标侧是空格分词语言，最易暴露 ▁ 泄漏
        let en = engine
            .translate("患者需要休息两周。", "zh", "en")
            .expect("zh->en 翻译失败");
        println!("[zh->en] {en}");
        assert!(!en.trim().is_empty(), "译文不应为空");
        assert!(!en.contains('\u{2581}'), "译文不应残留 SentencePiece 空格标记 ▁：{en}");
        assert!(
            en.contains(' '),
            "英文译文应含还原后的空格：{en}"
        );

        // 分片路径：超过 max_chars 的长文本应被切分并拼接
        let long = "The quick brown fox jumps over the lazy dog. ".repeat(60);
        let pieces = split_for_translation(&long, engine.max_chars());
        assert!(pieces.len() > 1, "长文本应被切成多片");
        let zh_long = engine
            .translate(&long, "en", "zh")
            .expect("长文本翻译失败");
        println!(
            "[en->zh 分片 {} 片] {}",
            pieces.len(),
            &zh_long.chars().take(80).collect::<String>()
        );
        assert!(zh_long.chars().count() > 20, "长文本译文不应过短");
    }
}