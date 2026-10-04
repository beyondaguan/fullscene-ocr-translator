//! `fs-core`：核心业务库。
//!
//! 承载与 UI 无关的全部能力，供 `crates/gui`（主程序）与 `crates/host`（NM 桥）
//! 共同依赖，避免双份实现：
//!
//! - [`config`] 配置加载 / 保存
//! - [`ocr`] / [`ocr_models`] PP-OCRv6 推理调度与三档模型管理
//! - [`translate`] Translate 轴：引擎 trait + 注册表 + 编排器（本地 LLM / 云端降级）
//! - [`database`] SQLite 历史库
//! - [`screenshot`] / [`hotkey`] Windows 截图与全局热键（`cfg(windows)`）
//! - [`wordpick`] 划词取词内核：UIA → 剪贴板 → 截屏 OCR 三级降级（`cfg(windows)`）
//! - [`types`] 双端共享数据类型（含 Native Messaging 协议载体）

#![warn(clippy::all)]

pub mod config;
pub mod database;
pub mod error;
pub mod llm_client;
pub mod llm_translate;
pub mod ocr;
pub mod ocr_models;
pub mod translate;
pub mod types;

#[cfg(windows)]
pub mod hotkey;
pub mod lang;
#[cfg(windows)]
pub mod screenshot;
#[cfg(windows)]
pub mod wordpick;

pub use error::{AppError, Result};
