//! 本地大模型引擎（Ollama / LM Studio），离线可用，无需密钥。

use crate::config::Config;
use crate::error::Result;
use crate::llm_client::LlmClient;
use crate::llm_translate;
use crate::translate::base::TranslateBase;

pub struct LocalLlmEngine {
    endpoint: String,
    model: String,
}

impl LocalLlmEngine {
    pub fn from_config(cfg: &Config) -> Self {
        Self {
            endpoint: cfg
                .llm_endpoint
                .clone()
                .unwrap_or_else(|| "http://127.0.0.1:11434".into()),
            model: cfg
                .llm_model
                .clone()
                .unwrap_or_else(|| "qwen2.5".into()),
        }
    }
}

impl TranslateBase for LocalLlmEngine {
    fn id(&self) -> &'static str {
        "local-llm"
    }

    fn label(&self) -> &'static str {
        "本地大模型 (Ollama)"
    }

    fn available(&self) -> bool {
        !self.endpoint.trim().is_empty()
    }

    fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String> {
        let client = LlmClient::new(self.endpoint.clone(), self.model.clone());
        llm_translate::translate(&client, text, src, dst)
    }
}
