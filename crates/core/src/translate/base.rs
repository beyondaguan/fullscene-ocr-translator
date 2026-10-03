//! 翻译引擎统一契约（六轴之 Translate 轴）。
//!
//! 每个引擎是一个 drop-in 实现：实现本 trait 并注册到 [`crate::translate::Registry`]
//! 即可被翻译路由器发现，无需修改任何编排代码（参照 WinOCR 3.4 的引擎 ABC + 注册表）。

use crate::error::Result;

/// 翻译引擎抽象基类。
///
/// 约定：
/// - [`available`](TranslateBase::available) 必须**零网络开销**——只判断密钥/端点是否已配置；
///   未配置即返回 `false`，路由器据此跳过，绝不发起请求后超时。
/// - [`translate`](TranslateBase::translate) 失败一律返回 [`crate::error::AppError::Translate`]，
///   便于上层聚合「末次错误」。
pub trait TranslateBase: Send + Sync {
    /// 引擎唯一 id（与配置、设置界面、降级链一致）。
    fn id(&self) -> &'static str;

    /// 展示名（设置界面下拉用）。
    fn label(&self) -> &'static str;

    /// 是否就绪（密钥/端点已配置）。严禁发起网络请求。
    fn available(&self) -> bool;

    /// 是否支持该语言对。默认全支持（多数云引擎不限语言对）。
    fn supports(&self, _src: &str, _dst: &str) -> bool {
        true
    }

    /// 单次请求可接受的**最大字符数**（按 `chars().count()` 计）。
    ///
    /// 超过即由注册表自动分片（见 `Registry::translate_with_fallback`）。
    /// 默认 4000（主流云引擎的常见上限）；有更严格限制的引擎必须覆写——
    /// 例：MyMemory 实测硬上限 500 字符（2026-10-03 真机验证）。
    fn max_chars(&self) -> usize {
        4000
    }

    /// 单次翻译。失败返回 [`crate::error::AppError::Translate`]。
    fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String>;
}
