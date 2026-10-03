//! Translate 轴：引擎 trait + 注册表 + 编排器（M7 重构）。
//!
//! 设计参照 WinOCR 3.4 的「六轴插件化 + 注册表自动发现」：
//! 引擎是 drop-in 实现（见 [`engines`]），编排器 [`Translator`] 不依赖任何具体引擎，
//! 只认 [`base::TranslateBase`] 契约与配置里的降级链。新增/替换引擎零改编排代码。

pub mod base;
pub mod engines;
pub mod http;
pub mod registry;

pub use base::TranslateBase;
pub use registry::{Registry, TranslationOutcome};

use crate::config::Config;
use crate::error::{AppError, Result};

/// 设置界面引擎信息（id + 展示名 + 是否可用）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct EngineInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
}

/// 单条对话消息（AI 助手抽屉 → Rust 后端 → 对话引擎）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatMessage {
    /// 角色：`system` / `user` / `assistant`
    pub role: String,
    /// 消息正文
    pub content: String,
}

/// 翻译编排器：持有注册表与降级链，对外暴露 `translate` / `translate_with`。
pub struct Translator {
    registry: Registry,
    fallback_order: Vec<String>,
}

impl Translator {
    /// 由配置构造：注册全部内置引擎，载入降级链（配置缺省则用内置默认）。
    pub fn from_config(cfg: &Config) -> Self {
        let mut registry = Registry::new();
        engines::register_all(&mut registry, cfg);
        let fallback = cfg
            .translate
            .as_ref()
            .map(|t| t.fallback_order.clone())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(default_fallback_order);
        Self {
            registry,
            fallback_order: fallback,
        }
    }

    /// 按当前降级链翻译，首个可用引擎成功即返回。
    pub fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String> {
        self.registry
            .translate_with_fallback(&self.fallback_order, text, src, dst)
    }

    /// 同 [`Self::translate`]，但额外回报**实际服务的引擎**与它在降级链中的位置。
    ///
    /// 状态栏需要显示「实际是谁翻译的」——降级链会静默换引擎，
    /// 只看配置链首项会与实际不符。
    pub fn translate_detailed(&self, text: &str, src: &str, dst: &str) -> Result<TranslationOutcome> {
        self.registry
            .translate_with_fallback_detailed(&self.fallback_order, text, src, dst)
    }

    /// 指定引擎翻译（设置界面「使用此引擎」）。
    pub fn translate_with(&self, engine_id: &str, text: &str, src: &str, dst: &str) -> Result<String> {
        let e = self
            .registry
            .get(engine_id)
            .ok_or_else(|| AppError::Translate(format!("未知引擎 {engine_id}")))?;
        e.translate(text, src, dst)
    }

    /// 当前降级链选主结果（首个 available 的引擎 id），供历史库记录 engine 字段。
    ///
    /// 全部不可用时返回 `"none"`。
    pub fn primary_engine_id(&self) -> &str {
        self.registry
            .select(&self.fallback_order)
            .map(|e| e.id())
            .unwrap_or("none")
    }

    /// 把首选可用引擎往后挪一位（`cycle_engine` 全局热键）。
    ///
    /// 返回 `(新首选引擎 id, 新的完整降级链)`；可用引擎不足 2 个时返回 `None`。
    pub fn cycle_primary(&self) -> Option<(String, Vec<String>)> {
        self.registry.cycle_primary(&self.fallback_order)
    }

    /// 列出全部已注册引擎（含可用状态），供设置界面渲染。
    pub fn list_engines(&self) -> Vec<EngineInfo> {
        self.registry
            .list()
            .iter()
            .map(|e| EngineInfo {
                id: e.id().to_string(),
                label: e.label().to_string(),
                available: e.available(),
            })
            .collect()
    }

    /// 当前降级链。
    pub fn fallback_order(&self) -> &[String] {
        &self.fallback_order
    }

    /// 多轮对话：调用首个「可用且支持对话」的 OpenAI 兼容引擎（SiliconFlow / OpenAI）。
    ///
    /// 顺序固定为 siliconflow → openai：两者都走 `/v1/chat/completions`，
    /// 但其它引擎（MyMemory / Google / 本地 LLM Ollama 的 generate 接口）不支持对话。
    /// 任一可用引擎调用失败会自动尝试下一个；二者都无密钥则给出明确提示而非静默失败。
    pub fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        for id in ["siliconflow", "openai"] {
            if let Some(e) = self.registry.get(id) {
                if e.available() {
                    if let Ok(r) = e.chat(messages) {
                        return Ok(r);
                    }
                }
            }
        }
        Err(AppError::Translate(
            "没有可用的对话引擎：请在设置中配置 SiliconFlow 或 OpenAI 密钥".into(),
        ))
    }
}

/// 内置默认降级链：免密钥引擎优先，本地 LLM 兜底。
fn default_fallback_order() -> Vec<String> {
    vec!["mymemory".into(), "google".into(), "local-llm".into()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::base::TranslateBase;

    /// 测试用 mock 引擎：可控 available / 输出 / 是否报错。
    struct MockEngine {
        id: &'static str,
        avail: bool,
        out: Option<String>,
        err: bool,
    }

    impl TranslateBase for MockEngine {
        fn id(&self) -> &'static str {
            self.id
        }
        fn label(&self) -> &'static str {
            self.id
        }
        fn available(&self) -> bool {
            self.avail
        }
        fn translate(&self, _t: &str, _s: &str, _d: &str) -> Result<String> {
            if self.err {
                Err(AppError::Translate("mock err".into()))
            } else {
                self.out.clone().ok_or_else(|| AppError::Translate("no out".into()))
            }
        }
    }

    #[test]
    fn registry_skips_unavailable_and_falls_back() {
        let mut r = Registry::new();
        r.register(Box::new(MockEngine { id: "a", avail: false, out: None, err: false }));
        r.register(Box::new(MockEngine { id: "b", avail: true, out: Some("译b".into()), err: false }));
        let t = r.translate_with_fallback(&["a".into(), "b".into()], "x", "auto", "zh").unwrap();
        assert_eq!(t, "译b");
    }

    #[test]
    fn registry_tries_next_on_runtime_error() {
        let mut r = Registry::new();
        r.register(Box::new(MockEngine { id: "a", avail: true, out: None, err: true }));
        r.register(Box::new(MockEngine { id: "b", avail: true, out: Some("译b".into()), err: false }));
        let t = r.translate_with_fallback(&["a".into(), "b".into()], "x", "auto", "zh").unwrap();
        assert_eq!(t, "译b");
    }

    #[test]
    fn registry_errors_when_all_unavailable() {
        let mut r = Registry::new();
        r.register(Box::new(MockEngine { id: "a", avail: false, out: None, err: false }));
        let err = r
            .translate_with_fallback(&["a".into()], "x", "auto", "zh")
            .unwrap_err();
        assert!(err.to_string().contains("无可用引擎"));
    }

    #[test]
    fn from_config_registers_all_builtin_engines() {
        let cfg = Config::default();
        let tr = Translator::from_config(&cfg);
        let engines = tr.list_engines();
        let ids: Vec<&str> = engines.iter().map(|e| e.id.as_str()).collect();
        for expected in ["local-llm", "mymemory", "google", "siliconflow", "openai", "edge", "bing"] {
            assert!(ids.contains(&expected), "缺少内置引擎 {expected}");
        }
    }

    #[test]
    fn from_config_uses_builtin_default_fallback_when_unset() {
        let tr = Translator::from_config(&Config::default());
        assert_eq!(
            tr.fallback_order(),
            &["mymemory".to_string(), "google".to_string(), "local-llm".to_string()]
        );
    }

    #[test]
    fn from_config_honors_configured_fallback_order() {
        let cfg = Config {
            translate: Some(crate::config::TranslateConfig {
                fallback_order: vec!["openai".into(), "edge".into()],
                ..Default::default()
            }),
            ..Default::default()
        };
        let tr = Translator::from_config(&cfg);
        assert_eq!(tr.fallback_order(), &["openai".to_string(), "edge".to_string()]);
    }

    #[test]
    fn translate_with_unknown_engine_errors() {
        let tr = Translator::from_config(&Config::default());
        let err = tr.translate_with("nope", "x", "auto", "zh").unwrap_err();
        assert!(err.to_string().contains("未知引擎"));
    }
}
