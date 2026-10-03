//! OpenAI 兼容聊天模型翻译引擎：SiliconFlow 与 OpenAI 共用同一协议。
//!
//! 两者差异仅在 base_url / 默认模型 / 密钥来源，故抽一个 [`chat_translate`] 共用实现。

use crate::config::Config;
use crate::error::{AppError, Result};
use crate::translate::base::TranslateBase;
use crate::translate::http::agent;
use crate::translate::ChatMessage;
use serde_json::json;
use std::time::Duration;

/// 调用 OpenAI 兼容 `/chat/completions` 完成翻译。
fn chat_translate(
    base_url: &str,
    api_key: &str,
    model: &str,
    text: &str,
    src: &str,
    dst: &str,
) -> Result<String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let src_hint = if src.is_empty() || src.eq_ignore_ascii_case("auto") {
        "自动识别源语言"
    } else {
        src
    };
    let system = "你是专业翻译引擎。只输出译文，不要解释、不要标点以外的附加内容。";
    let user = format!("将以下{}文本翻译为{}：\n{}", src_hint, dst, text);
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "temperature": 0.3,
        "stream": false,
    });

    let resp = agent(Duration::from_secs(60))
        .post(&url)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| AppError::Translate(format!("模型接口请求失败: {e}")))?;

    let parsed: serde_json::Value = resp
        .into_json()
        .map_err(|e| AppError::Translate(format!("模型响应解析失败: {e}")))?;
    let content = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Translate("模型响应缺少 choices[0].message.content".into()))?;
    Ok(content.trim().to_string())
}

/// 调用 OpenAI 兼容 `/chat/completions` 进行多轮对话（AI 助手抽屉）。
///
/// `messages` 为完整对话历史（系统/用户/助手角色），由上层按时间顺序组装。
/// 与 [`chat_translate`] 共用同一协议与鉴权头，只是系统提示换成通用助手、温度略高。
fn chat_completion(
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
) -> Result<String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| json!({"role": m.role, "content": m.content}))
        .collect();
    let body = json!({
        "model": model,
        "messages": msgs,
        "temperature": 0.7,
        "stream": false,
    });

    let resp = agent(Duration::from_secs(120))
        .post(&url)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| AppError::Translate(format!("对话接口请求失败: {e}")))?;

    let parsed: serde_json::Value = resp
        .into_json()
        .map_err(|e| AppError::Translate(format!("对话响应解析失败: {e}")))?;
    let content = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Translate("对话响应缺少 choices[0].message.content".into()))?;
    Ok(content.trim().to_string())
}

/// SiliconFlow 引擎（兼容 OpenAI 协议）。
#[derive(Default)]
pub struct SiliconFlowEngine {
    base_url: String,
    api_key: Option<String>,
    /// 翻译模型（默认免费档 Hunyuan-MT-7B，翻译专用）。
    model: String,
    /// 对话（AI 助手）模型：通用模型，与翻译模型区分，避免把翻译专用模型误用于对话。
    chat_model: String,
}

impl SiliconFlowEngine {
    pub fn from_config(cfg: &Config) -> Self {
        let t = cfg.translate.as_ref();
        Self {
            base_url: t
                .and_then(|x| x.siliconflow_base_url.clone())
                .unwrap_or_else(|| "https://api.siliconflow.cn/v1".into()),
            api_key: t.and_then(|x| x.siliconflow_key.clone()),
            // 默认必须是**免费**模型。默认值曾写成 `deepseek-ai/DeepSeek-V3`（付费，
            // ¥2/¥8 每百万 token）——用户只填了 API Key 就直接发请求，会产生真金白银的
            // 账单而界面上毫无提示。Hunyuan-MT-7B 输入输出均 ¥0，且是翻译专用模型
            // （WMT2025 31 语种 30 冠），比通用大模型更贴合本项目的翻译场景。
            model: t
                .and_then(|x| x.siliconflow_model.clone())
                .unwrap_or_else(|| "tencent/Hunyuan-MT-7B".into()),
            // 对话用通用模型（默认 SiliconFlow 免费通用模型 Qwen2.5-7B-Instruct），
            // 不复用上面的翻译专用模型。
            chat_model: t
                .and_then(|x| x.siliconflow_chat_model.clone())
                .unwrap_or_else(|| "Qwen/Qwen2.5-7B-Instruct".into()),
        }
    }

    #[cfg(test)]
    pub fn with_test(mut self, base_url: impl Into<String>, key: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self.api_key = Some(key.into());
        self
    }
}

impl TranslateBase for SiliconFlowEngine {
    fn id(&self) -> &'static str {
        "siliconflow"
    }

    fn label(&self) -> &'static str {
        "SiliconFlow"
    }

    fn available(&self) -> bool {
        self.api_key
            .as_ref()
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false)
    }

    fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String> {
        let key = self
            .api_key
            .clone()
            .ok_or_else(|| AppError::Translate("SiliconFlow 未配置密钥".into()))?;
        chat_translate(&self.base_url, &key, &self.model, text, src, dst)
    }

    fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        let key = self
            .api_key
            .clone()
            .ok_or_else(|| AppError::Translate("SiliconFlow 未配置密钥".into()))?;
        // 对话必须用通用模型（chat_model），不复用翻译专用模型 self.model。
        chat_completion(&self.base_url, &key, &self.chat_model, messages)
    }
}

/// OpenAI 官方 / 任意 OpenAI 兼容网关。
#[derive(Default)]
pub struct OpenAiEngine {
    base_url: String,
    api_key: Option<String>,
    model: String,
}

impl OpenAiEngine {
    pub fn from_config(cfg: &Config) -> Self {
        let t = cfg.translate.as_ref();
        Self {
            base_url: t
                .and_then(|x| x.openai_base_url.clone())
                .unwrap_or_else(|| "https://api.openai.com/v1".into()),
            api_key: t.and_then(|x| x.openai_key.clone()),
            model: t
                .and_then(|x| x.openai_model.clone())
                .unwrap_or_else(|| "gpt-4o-mini".into()),
        }
    }

    #[cfg(test)]
    pub fn with_test(mut self, base_url: impl Into<String>, key: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self.api_key = Some(key.into());
        self
    }
}

impl TranslateBase for OpenAiEngine {
    fn id(&self) -> &'static str {
        "openai"
    }

    fn label(&self) -> &'static str {
        "OpenAI"
    }

    fn available(&self) -> bool {
        self.api_key
            .as_ref()
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false)
    }

    fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String> {
        let key = self
            .api_key
            .clone()
            .ok_or_else(|| AppError::Translate("OpenAI 未配置密钥".into()))?;
        chat_translate(&self.base_url, &key, &self.model, text, src, dst)
    }

    fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        let key = self
            .api_key
            .clone()
            .ok_or_else(|| AppError::Translate("OpenAI 未配置密钥".into()))?;
        chat_completion(&self.base_url, &key, &self.model, messages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_util::start_mock;

    /// 默认模型必须是免费档：曾经默认 `deepseek-ai/DeepSeek-V3`（付费 ¥2/¥8 每百万 token），
    /// 用户只填 API Key 就会静默产生账单。此测试锁死默认值为免费翻译模型。
    #[test]
    fn siliconflow_default_model_is_free_tier() {
        let e = SiliconFlowEngine::from_config(&Config::default());
        assert_eq!(
            e.model, "tencent/Hunyuan-MT-7B",
            "默认模型必须是免费档，改成付费模型会让用户静默产生账单"
        );
    }

    /// 显式配置的模型优先于默认值。
    #[test]
    fn siliconflow_configured_model_overrides_default() {
        let cfg = Config {
            translate: Some(crate::config::TranslateConfig {
                siliconflow_model: Some("THUDM/GLM-Z1-9B-0414".into()),
                ..Default::default()
            }),
            ..Config::default()
        };
        assert_eq!(
            SiliconFlowEngine::from_config(&cfg).model,
            "THUDM/GLM-Z1-9B-0414"
        );
    }

    #[test]
    fn siliconflow_translate_via_mock() {
        // 返回 OpenAI 兼容结构
        let body = r#"{"choices":[{"message":{"content":"你好"}}]}"#;
        let (h, url) = start_mock(body);
        let e = SiliconFlowEngine::default().with_test(url, "sk-test");
        let t = e.translate("hello", "en", "zh").unwrap();
        assert_eq!(t, "你好");
        drop(h);
    }

    #[test]
    fn siliconflow_unavailable_without_key() {
        assert!(!SiliconFlowEngine::default().available());
    }

    #[test]
    fn openai_translate_via_mock() {
        let body = r#"{"choices":[{"message":{"content":"世界"}}]}"#;
        let (h, url) = start_mock(body);
        let e = OpenAiEngine::default().with_test(url, "sk-test");
        let t = e.translate("world", "en", "zh").unwrap();
        assert_eq!(t, "世界");
        drop(h);
    }
}
