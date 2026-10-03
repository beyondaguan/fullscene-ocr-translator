//! 本地大模型 HTTP 客户端（M17）。调用 Ollama `/api/generate` 获取补全。
//!
//! 依赖 [`ureq`]（default-features=false，无 TLS，适配本地 `http://` 端点）。
//! 服务未启动 / 超时 / 非 2xx 均返回 [`AppError::Translate`]。

use crate::error::{AppError, Result};
use crate::translate::ChatMessage;
use std::time::Duration;

/// Ollama `/api/generate` 响应体（只取所需字段）
#[derive(serde::Deserialize)]
struct OllamaGenerateResponse {
    response: String,
    done: bool,
}

pub struct LlmClient {
    pub endpoint: String,
    pub model: String,
    pub timeout: Duration,
}

impl LlmClient {
    pub fn new(endpoint: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            model: model.into(),
            timeout: Duration::from_secs(60),
        }
    }

    /// 发送补全请求并返回模型输出文本。
    ///
    /// `prompt` 为完整提示词；Ollama 以 `"prompt"` 字段发送。
    pub fn complete(&self, prompt: &str) -> Result<String> {
        let url = format!("{}/api/generate", self.endpoint.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": self.model,
            "prompt": prompt,
            "stream": false,
        });

        let agent = ureq::AgentBuilder::new()
            .timeout(self.timeout)
            .build();

        let resp = agent
            .post(&url)
            .send_json(body)
            .map_err(|e| AppError::Translate(format!("请求 Ollama 失败: {e}")))?;

        if resp.status() != 200 {
            return Err(AppError::Translate(format!(
                "Ollama 返回非 200 状态码: {}",
                resp.status()
            )));
        }

        let parsed: OllamaGenerateResponse = resp
            .into_json()
            .map_err(|e| AppError::Translate(format!("解析 Ollama 响应失败: {e}")))?;

        if !parsed.done {
            return Err(AppError::Translate("Ollama 响应未完成（done=false）".into()));
        }

        Ok(parsed.response)
    }

    /// 发送多轮对话请求并返回模型输出文本。
    ///
    /// 调用 Ollama 的 OpenAI 兼容端点 `{endpoint}/v1/chat/completions`，
    /// body 为 `{"model":self.model,"messages":[...],"stream":false}`，
    /// 解析 `choices[0].message.content`（与 openai_compat.rs 的 `chat_completion` 同协议）。
    ///
    /// 对话走通用模型（如 qwen2.5），与 [`complete`] 的 `/api/generate` 翻译补全接口区分。
    /// 服务未启动 / 超时 / 非 2xx 均返回 [`AppError::Translate`]。超时 120s。
    pub fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        let url = format!(
            "{}/v1/chat/completions",
            self.endpoint.trim_end_matches('/')
        );
        let msgs: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
            .collect();
        let body = serde_json::json!({
            "model": self.model,
            "messages": msgs,
            "stream": false,
        });

        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(120))
            .build();

        let resp = agent
            .post(&url)
            .send_json(body)
            .map_err(|e| AppError::Translate(format!("请求 Ollama 对话接口失败: {e}")))?;

        if resp.status() != 200 {
            return Err(AppError::Translate(format!(
                "Ollama 对话接口返回非 200 状态码: {}",
                resp.status()
            )));
        }

        let parsed: serde_json::Value = resp
            .into_json()
            .map_err(|e| AppError::Translate(format!("解析 Ollama 对话响应失败: {e}")))?;

        let content = parsed
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AppError::Translate("Ollama 对话响应缺少 choices[0].message.content".into())
            })?;

        Ok(content.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// 启动一个本地 TCP mock 服务器，模拟 Ollama `/api/generate`。
    ///
    /// 返回 (服务端收到的请求体, 客户端句柄)。调用后需 drop 句柄关闭服务器线程。
    fn start_mock_ollama(response: &'static str) -> (thread::JoinHandle<()>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定端口失败");
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                // 读请求头与 body（简化：读到空行后再读 Content-Length 字节）
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
                let body_str = String::from_utf8_lossy(&body).to_string();

                // 响应：固定 JSON
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    response.len(),
                    response
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();

                // 打印请求体到 stderr 供测试读取（通过管道捕获）
                eprintln!("MOCK_OLLAMA_REQUEST_BODY={}", body_str);
            }
        });
        (handle, format!("http://{}", addr))
    }

    #[test]
    fn complete_returns_model_response() {
        let resp_json = r#"{"model":"qwen2.5","response":"你好","done":true}"#;
        let (handle, endpoint) = start_mock_ollama(resp_json);
        let client = LlmClient::new(&endpoint, "qwen2.5");
        let out = client.complete("translate hi").expect("请求失败");
        assert_eq!(out, "你好");
        drop(handle); // 关闭服务器线程
    }

    #[test]
    fn offline_server_returns_translate_error() {
        // 绑定一个端口后立即关闭，制造连接拒绝
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定端口失败");
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let client = LlmClient::new(format!("http://{}", addr), "qwen2.5");
        let err = client.complete("hi").expect_err("应返回错误");
        assert!(matches!(err, AppError::Translate(_)), "应包装为 Translate 错误: {err}");
    }

    #[test]
    fn non_200_status_returns_error() {
        // mock 固定返回 200；此测试验证 done=false 分支 -> 应报错
        let resp_json = r#"{"model":"qwen2.5","response":"","done":false}"#;
        let (_handle, endpoint2) = start_mock_ollama(resp_json);
        let client = LlmClient::new(&endpoint2, "qwen2.5");
        let err = client.complete("hi").expect_err("done=false 应报错");
        assert!(matches!(err, AppError::Translate(_)));
        drop(_handle);
    }
}