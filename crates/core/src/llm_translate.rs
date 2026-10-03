//! 翻译调度（M17）：调用本地大模型完成翻译。

use crate::error::Result;
use crate::llm_client::LlmClient;

pub fn translate(client: &LlmClient, text: &str, src: &str, dst: &str) -> Result<String> {
    // src 为空或 "auto" 时让模型自动识别源语言，避免 prompt 出现「auto 文本」这类不通表达
    let src_hint = if src.is_empty() || src.eq_ignore_ascii_case("auto") {
        "自动识别源语言"
    } else {
        src
    };
    let prompt = format!("将以下{}文本翻译为{}，只输出译文：\n{}", src_hint, dst, text);
    client.complete(&prompt)
}
