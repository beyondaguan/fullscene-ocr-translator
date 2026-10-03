//! Translate 轴全部引擎实现。新增引擎 = 在此目录加一个文件 + 在 [`register_all`] 注册一行。

mod azure;
mod google;
mod local_llm;
mod mymemory;
mod openai_compat;

pub use azure::{BingEngine, EdgeEngine};
pub use google::GoogleEngine;
pub use local_llm::LocalLlmEngine;
pub use mymemory::MyMemoryEngine;
pub use openai_compat::{OpenAiEngine, SiliconFlowEngine};

use crate::config::Config;
use crate::translate::registry::Registry;

/// 注册全部内置引擎到注册表（由 [`crate::translate::Translator::from_config`] 调用）。
pub fn register_all(registry: &mut Registry, cfg: &Config) {
    registry.register(Box::new(LocalLlmEngine::from_config(cfg)));
    registry.register(Box::new(MyMemoryEngine::default()));
    registry.register(Box::new(GoogleEngine::default()));
    registry.register(Box::new(SiliconFlowEngine::from_config(cfg)));
    registry.register(Box::new(OpenAiEngine::from_config(cfg)));
    registry.register(Box::new(EdgeEngine::from_config(cfg)));
    registry.register(Box::new(BingEngine::from_config(cfg)));
}
