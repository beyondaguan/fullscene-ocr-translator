//! `fs-platform`：平台能力抽象层（ADR-001 脚手架阶段）。
//!
//! 本 crate 是整个系统的**最底层之一**，自身不依赖 `fs-core`，以避免 crate 循环依赖：
//! 最终方向是 `fs-core → fs-platform`（core 通过 trait 调用平台能力），若 `fs-platform`
//! 反过来依赖 `fs-core` 取类型即会成环。因此平台无关领域类型（见 [`types`]）也归本层。
//!
//! 本阶段仅搭骨架、定义契约：
//! - [`PlatformError`]：平台层统一错误。
//! - [`ScreenshotProvider`] / [`HotkeyProvider`] / [`TrayProvider`]：平台能力 trait。
//! - `HotkeyHandle`：热键生命周期句柄。
//!
//! 当前 trait **暂无实现者**；`#[allow(dead_code)]` 为临时标记，M1 接入 Windows 实现后移除。

#![allow(dead_code)]

pub mod types;
pub use types::*;

/// 平台层统一错误。与 `fs-core::AppError` 解耦，避免 `fs-platform → fs-core` 反向依赖。
#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error("截图失败: {0}")]
    Capture(String),
    #[error("热键失败: {0}")]
    Hotkey(String),
    #[error("托盘失败: {0}")]
    Tray(String),
}

/// 屏幕截图能力。实现者负责把平台原语（如 GDI）封装为跨平台一致的入口。
///
/// 方法签名对齐原 `fs-core/src/screenshot.rs`，M1 迁移时语义不变。
pub trait ScreenshotProvider {
    /// 枚举所有显示器（虚拟屏坐标）。
    fn list_monitors(&self) -> Vec<MonitorInfo>;
    /// 截取屏幕：`None` = 主显示器全屏；`Some([x,y,w,h])` = 区域（自动夹取到屏幕内）。
    fn capture(&self, region: Option<[i32; 4]>) -> Result<RawImage, PlatformError>;
    /// 截取全部显示器合并的虚拟屏。
    fn capture_virtual(&self) -> Result<RawImage, PlatformError>;
    /// 截取指定索引显示器。
    fn capture_monitor(&self, index: usize) -> Result<RawImage, PlatformError>;
    /// 截取光标当前所在显示器（失败安全回退主显示器）。
    fn capture_active_monitor(&self) -> Result<RawImage, PlatformError>;
    /// 按 [`CaptureTarget`] 统一入口。
    fn capture_target(&self, target: CaptureTarget) -> Result<RawImage, PlatformError>;
}

/// 全局热键句柄。持有监听线程 ID，可主动停止（注销热键并结束线程）。
///
/// 注册失败时为「空句柄」（`stop()` 无操作），应用照常运行——热键是便利功能，
/// 被占用绝不能阻断应用启动。
pub struct HotkeyHandle {
    stop_fn: Box<dyn Fn() + Send + Sync>,
}

impl HotkeyHandle {
    /// 构造一个空句柄（M1 由实现填充真实 `stop_fn`）。
    pub fn inert() -> Self {
        HotkeyHandle {
            stop_fn: Box::new(|| {}),
        }
    }

    /// 注销热键并结束监听线程。
    pub fn stop(&self) {
        (self.stop_fn)();
    }
}

/// 全局热键能力。实现者负责跨平台地注册系统级热键并回调。
pub trait HotkeyProvider {
    /// 注册全局热键并在独立线程监听触发；返回 [`HotkeyHandle`] 供热重载时 `stop()`。
    fn spawn_hotkey_loop<F>(&self, combo: &str, on_trigger: F) -> Result<HotkeyHandle, PlatformError>
    where
        F: Fn() + Send + 'static;
}

/// 系统托盘能力（图标 / 菜单 / 双击聚焦）。M1 填充。
pub trait TrayProvider {
    /// 在托盘区放置图标并绑定菜单回调（占位签名，M1 细化）。
    fn mount(&self) -> Result<(), PlatformError>;
}
