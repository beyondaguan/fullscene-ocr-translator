//! Microsoft Translator (Azure) 引擎：Edge 与 Bing 共用同一协议，独立密钥/区域。
//!
//! Bing Translator 现已并入 Azure Cognitive Services，故两者走同一 `translate` 端点，
//! 仅订阅密钥与区域不同（便于用户为两个品牌保留独立额度）。

use crate::config::Config;
use crate::error::{AppError, Result};
use crate::translate::base::TranslateBase;
use crate::translate::http::agent;
use serde_json::json;
use std::time::Duration;

const AZURE_ENDPOINT: &str = "https://api.cognitive.microsofttranslator.com";

fn azure_translate(
    endpoint: &str,
    key: &str,
    region: &str,
    text: &str,
    src: &str,
    dst: &str,
) -> Result<String> {
    let from = if src.is_empty() || src.eq_ignore_ascii_case("auto") {
        String::new()
    } else {
        format!("&from={src}")
    };
    let url = format!(
        "{}/translate?api-version=3.0&to={}{}",
        endpoint.trim_end_matches('/'),
        dst,
        from
    );
    let body = json!([{ "Text": text }]);
    let resp = agent(Duration::from_secs(20))
        .post(&url)
        .set("Ocp-Apim-Subscription-Key", key)
        .set("Ocp-Apim-Subscription-Region", region)
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| AppError::Translate(format!("Azure 翻译请求失败: {e}")))?;
    let parsed: serde_json::Value = resp
        .into_json()
        .map_err(|e| AppError::Translate(format!("Azure 响应解析失败: {e}")))?;
    let t = parsed
        .get(0)
        .and_then(|a| a.get("translations"))
        .and_then(|t| t.get(0))
        .and_then(|t| t.get("text"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Translate("Azure 响应缺少 translations[0].text".into()))?;
    Ok(t.to_string())
}

/// Microsoft Edge / Azure Translator 引擎。
#[derive(Default)]
pub struct EdgeEngine {
    base_url: String,
    key: Option<String>,
    region: Option<String>,
}

impl EdgeEngine {
    pub fn from_config(cfg: &Config) -> Self {
        let t = cfg.translate.as_ref();
        Self {
            base_url: AZURE_ENDPOINT.into(),
            key: t.and_then(|x| x.edge_key.clone()),
            region: t.and_then(|x| x.edge_region.clone()),
        }
    }

    #[cfg(test)]
    pub fn with_test(
        mut self,
        base_url: impl Into<String>,
        key: impl Into<String>,
        region: impl Into<String>,
    ) -> Self {
        self.base_url = base_url.into();
        self.key = Some(key.into());
        self.region = Some(region.into());
        self
    }
}

impl TranslateBase for EdgeEngine {
    fn id(&self) -> &'static str {
        "edge"
    }

    fn label(&self) -> &'static str {
        "Microsoft Edge / Azure 翻译"
    }

    fn available(&self) -> bool {
        self.key
            .as_ref()
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false)
            && self
                .region
                .as_ref()
                .map(|r| !r.trim().is_empty())
                .unwrap_or(false)
    }

    fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String> {
        let key = self
            .key
            .clone()
            .ok_or_else(|| AppError::Translate("Edge 翻译未配置密钥".into()))?;
        let region = self
            .region
            .clone()
            .ok_or_else(|| AppError::Translate("Edge 翻译未配置区域".into()))?;
        azure_translate(&self.base_url, &key, &region, text, src, dst)
    }
}

/// Bing 翻译引擎（Azure 协议，独立密钥/区域）。
#[derive(Default)]
pub struct BingEngine {
    base_url: String,
    key: Option<String>,
    region: Option<String>,
}

impl BingEngine {
    pub fn from_config(cfg: &Config) -> Self {
        let t = cfg.translate.as_ref();
        Self {
            base_url: AZURE_ENDPOINT.into(),
            key: t.and_then(|x| x.bing_key.clone()),
            region: t.and_then(|x| x.bing_region.clone()),
        }
    }

    #[cfg(test)]
    pub fn with_test(
        mut self,
        base_url: impl Into<String>,
        key: impl Into<String>,
        region: impl Into<String>,
    ) -> Self {
        self.base_url = base_url.into();
        self.key = Some(key.into());
        self.region = Some(region.into());
        self
    }
}

impl TranslateBase for BingEngine {
    fn id(&self) -> &'static str {
        "bing"
    }

    fn label(&self) -> &'static str {
        "Bing 翻译 (Azure)"
    }

    fn available(&self) -> bool {
        self.key
            .as_ref()
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false)
            && self
                .region
                .as_ref()
                .map(|r| !r.trim().is_empty())
                .unwrap_or(false)
    }

    fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String> {
        let key = self
            .key
            .clone()
            .ok_or_else(|| AppError::Translate("Bing 翻译未配置密钥".into()))?;
        let region = self
            .region
            .clone()
            .ok_or_else(|| AppError::Translate("Bing 翻译未配置区域".into()))?;
        azure_translate(&self.base_url, &key, &region, text, src, dst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_util::start_mock;

    #[test]
    fn edge_translate_via_mock() {
        let (h, url) = start_mock(r#"[{"translations":[{"text":"你好","to":"zh"}]}]"#);
        let e = EdgeEngine::default().with_test(url, "k", "r");
        let t = e.translate("hello", "en", "zh").unwrap();
        assert_eq!(t, "你好");
        drop(h);
    }

    #[test]
    fn bing_translate_via_mock() {
        let (h, url) = start_mock(r#"[{"translations":[{"text":"世界","to":"zh"}]}]"#);
        let e = BingEngine::default().with_test(url, "k", "r");
        let t = e.translate("world", "en", "zh").unwrap();
        assert_eq!(t, "世界");
        drop(h);
    }

    #[test]
    fn unavailable_without_key_or_region() {
        assert!(!EdgeEngine::default().available());
        assert!(!BingEngine::default().available());
        // 仅 key 无 region -> 仍不可用
        assert!(!EdgeEngine::default().with_test("x", "k", "").available());
    }
}
