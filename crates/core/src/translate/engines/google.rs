//! Google 翻译引擎：走公开 `translate_a/single` 端点，免密钥（best-effort，限流）。
//!
//! 注：该端点为 Google 网页端内部接口，无 SLA；作为「免密钥兜底」使用，
//! 生产级稳定翻译请配置 OpenAI / SiliconFlow / Edge 等带密钥引擎。

use crate::error::{AppError, Result};
use crate::translate::base::TranslateBase;
use crate::translate::http::{agent, urlencode};
use std::time::Duration;

const DEFAULT_BASE: &str = "https://translate.googleapis.com";

pub struct GoogleEngine {
    base_url: String,
}

impl Default for GoogleEngine {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE.into(),
        }
    }
}

impl GoogleEngine {
    #[cfg(test)]
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }
}

impl TranslateBase for GoogleEngine {
    fn id(&self) -> &'static str {
        "google"
    }

    fn label(&self) -> &'static str {
        "Google 翻译 (免密钥)"
    }

    fn available(&self) -> bool {
        true
    }

    fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String> {
        let sl = if src.is_empty() || src.eq_ignore_ascii_case("auto") {
            "auto"
        } else {
            src
        };
        let url = format!(
            "{}/translate_a/single?client=gtx&sl={}&tl={}&dt=t&q={}",
            self.base_url,
            urlencode(sl),
            urlencode(dst),
            urlencode(text)
        );
        let resp = agent(Duration::from_secs(15))
            .get(&url)
            .call()
            .map_err(|e| AppError::Translate(format!("Google 请求失败: {e}")))?;
        let body: serde_json::Value = resp
            .into_json()
            .map_err(|e| AppError::Translate(format!("Google 响应解析失败: {e}")))?;
        // 结构：[[["句子1译文", ...], ["句子2译文", ...]], ...]
        // body[0] 是句子数组，每句自身是 ["译文", 原文, null, null, 1]
        let sentences = body
            .get(0)
            .and_then(|a| a.as_array())
            .ok_or_else(|| AppError::Translate("Google 响应结构异常".into()))?;
        let mut out = String::new();
        for s in sentences {
            if let Some(t) = s.get(0).and_then(|v| v.as_str()) {
                out.push_str(t);
            }
        }
        if out.trim().is_empty() {
            return Err(AppError::Translate("Google 返回空译文".into()));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_util::start_mock;

    #[test]
    fn translate_via_mock() {
        // gtx 端点结构：[[["你好", ...]], ...]
        let (h, url) = start_mock(r#"[[["你好", "hello", null, null, 1]], null, "en"]"#);
        let e = GoogleEngine::default().with_base_url(url);
        let t = e.translate("hello", "en", "zh").unwrap();
        assert_eq!(t, "你好");
        drop(h);
    }

    #[test]
    fn available_keyless() {
        assert!(GoogleEngine::default().available());
    }
}
