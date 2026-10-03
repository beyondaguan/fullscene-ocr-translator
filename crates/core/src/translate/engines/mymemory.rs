//! MyMemory 翻译引擎：免费、免密钥（有每日限额），开箱即用。

use crate::error::{AppError, Result};
use crate::translate::base::TranslateBase;
use crate::translate::http::{agent, urlencode};
use std::time::Duration;

const DEFAULT_BASE: &str = "https://api.mymemory.translated.net";

pub struct MyMemoryEngine {
    base_url: String,
}

impl Default for MyMemoryEngine {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE.into(),
        }
    }
}

impl MyMemoryEngine {
    #[cfg(test)]
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }
}

/// 两个语言标签是否同一语种（只比主码：`zh-CN` / `zh-Hans` / `zh` 都算 zh）。
fn same_language(a: &str, b: &str) -> bool {
    let main = |s: &str| -> String { s.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase() };
    let (x, y) = (main(a), main(b));
    !x.is_empty() && x == y
}

impl TranslateBase for MyMemoryEngine {
    fn id(&self) -> &'static str {
        "mymemory"
    }

    fn label(&self) -> &'static str {
        "MyMemory (免费)"
    }

    fn available(&self) -> bool {
        true // 免密钥，限流但可用
    }

    /// MyMemory 硬上限 500 **字符**（实测：468 字通过 / 585 字拒答，2026-10-03）。
    /// 留 50 字余量给标点与分词误差。超过会返回 200 + 报错串，见 `translate`。
    fn max_chars(&self) -> usize {
        450
    }

    fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String> {
        let src_pair = if src.is_empty() || src.eq_ignore_ascii_case("auto") {
            "autodetect"
        } else {
            src
        };
        let url = format!(
            "{}/get?q={}&langpair={}|{}",
            self.base_url,
            urlencode(text),
            urlencode(src_pair),
            urlencode(dst)
        );
        let resp = agent(Duration::from_secs(15))
            .get(&url)
            .call()
            .map_err(|e| AppError::Translate(format!("MyMemory 请求失败: {e}")))?;
        let body: serde_json::Value = resp
            .into_json()
            .map_err(|e| AppError::Translate(format!("MyMemory 响应解析失败: {e}")))?;
        let node = body
            .get("responseData")
            .and_then(|d| d.get("translatedText"))
            .ok_or_else(|| AppError::Translate("MyMemory 响应缺少 responseData.translatedText".into()))?;
        // 源语言 = 目标语言时，MyMemory 返回 200 但 translatedText 是 **null**
        // （实测 2026-10-03：detectedLanguage=zh-CN、目标 zh → null，不是错误码）。
        // 必须识别出来并给出可诊断的原因，否则会被当成「响应缺字段」误导排查方向。
        let Some(t) = node.as_str() else {
            let detected = body
                .get("responseData")
                .and_then(|d| d.get("detectedLanguage"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // 源语言 = 目标语言 → 这不是错误，是「无需翻译」。
            // 此时返回原文（Ok）比返回 Err 更符合用户预期：
            // 返回 Err 会让降级链一路失败、最后甩给用户一句「翻译失败」，
            // 而实际上 OCR 出的内容本身就是中文。
            // 注意：判定必须依赖引擎返回的 detectedLanguage——MyMemory 的 autodetect
            // 对中英混排会直接判成 zh-CN，靠我们自己数汉字占比猜不准。
            if same_language(detected, dst) {
                return Ok(text.to_string());
            }
            return Err(AppError::Translate(format!(
                "MyMemory 未返回译文（检测到源语言 {detected}，目标 {dst}）"
            )));
        };
        // 超限/限流时 MyMemory 仍回 HTTP 200，把报错文案塞进 translatedText。
        // 不拦截的话，这段英文会被当成译文回填给用户（真机上表现为「翻译成功但内容是
        // QUERY LENGTH LIMIT EXCEEDED…」），且会阻断降级链继续尝试其它引擎。
        if t.contains("QUERY LENGTH LIMIT") || t.contains("MYMEMORY WARNING") {
            return Err(AppError::Translate(format!("MyMemory 拒答: {t}")));
        }
        Ok(t.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_util::start_mock;

    #[test]
    fn translate_via_mock() {
        let (h, url) = start_mock(r#"{"responseData":{"translatedText":"你好"}}"#);
        let e = MyMemoryEngine::default().with_base_url(url);
        let t = e.translate("hello", "en", "zh").unwrap();
        assert_eq!(t, "你好");
        drop(h);
    }

    #[test]
    fn available_keyless() {
        assert!(MyMemoryEngine::default().available());
    }

    #[test]
    fn same_language_compares_primary_subtag_only() {
        assert!(same_language("zh-CN", "zh"));
        assert!(same_language("zh-Hans", "zh-CN"));
        assert!(same_language("EN-GB", "en"));
        assert!(!same_language("zh-CN", "en"));
        assert!(!same_language("", "zh"));
    }

    /// 回归：源语言=目标语言时 MyMemory 返回 200 + translatedText:null，
    /// 必须回落为「返回原文」而不是报错，否则整条降级链失败、用户只看到「翻译失败」。
    #[test]
    fn source_equals_target_returns_original_text() {
        let body = r#"{"responseData":{"translatedText":null,"detectedLanguage":"zh-CN"}}"#;
        let (h, url) = start_mock(body);
        let e = MyMemoryEngine::default().with_base_url(url);
        let out = e.translate("前列腺癌筛查", "auto", "zh").unwrap();
        assert_eq!(out, "前列腺癌筛查");
        drop(h);
    }
}
