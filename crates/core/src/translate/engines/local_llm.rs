//! 本地大模型引擎（Ollama / LM Studio），离线可用，无需密钥。

use crate::config::Config;
use crate::error::Result;
use crate::llm_client::LlmClient;
use crate::llm_translate;
use crate::translate::base::TranslateBase;
use crate::translate::ChatMessage;

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

    /// 多轮对话：走 Ollama 的 OpenAI 兼容端点 `/v1/chat/completions`（通用模型，如 qwen2.5），
    /// 与翻译用的 `/api/generate` 区分。本地模型离线免费，作为 AI 助手首选引擎。
    fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        let client = LlmClient::new(self.endpoint.clone(), self.model.clone());
        client.chat(messages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// 启动一个本地 TCP mock 服务器，模拟 Ollama `/v1/chat/completions`，
    /// 返回固定 OpenAI 格式 JSON。仿照 `llm_client.rs::start_mock_ollama`。
    fn start_mock_ollama_chat(response: &'static str) -> (thread::JoinHandle<()>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定端口失败");
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                let _ = reader.read_line(&mut request_line).unwrap();
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 {
                        break;
                    }
                    let trimmed = line.trim_end();
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some(v) = trimmed.to_lowercase().strip_prefix("content-length:") {
                        content_length = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; content_length];
                let _ = reader.read_exact(&mut body).unwrap();
                let _body_str = String::from_utf8_lossy(&body).to_string();

                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    response.len(),
                    response
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        (handle, format!("http://{}", addr))
    }

    #[test]
    fn local_llm_chat_returns_model_response() {
        // 返回 OpenAI 兼容对话结构
        let body = r#"{"choices":[{"message":{"content":"回复"}}]}"#;
        let (handle, endpoint) = start_mock_ollama_chat(body);
        let cfg = Config {
            llm_endpoint: Some(endpoint),
            llm_model: Some("qwen2.5".into()),
            ..Default::default()
        };
        let engine = LocalLlmEngine::from_config(&cfg);
        let reply = engine
            .chat(&[ChatMessage {
                role: "user".into(),
                content: "你好".into(),
            }])
            .expect("对话失败");
        assert_eq!(reply, "回复");
        drop(handle);
    }
}
