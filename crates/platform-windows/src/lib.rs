//! `fs-platform-windows`：Windows 平台能力实现（ADR-001 脚手架阶段）。
//!
//! 本期为**空壳**。M1 将把 `fs-core/src/screenshot.rs`（GDI `BitBlt`/`GetDIBits`）与
//! `fs-core/src/hotkey.rs`（`RegisterHotKey` + 线程消息循环）的 Win32 实现迁移至本 crate，
//! 并实现 [`fs_platform::ScreenshotProvider`] / [`fs_platform::HotkeyProvider`]。
//!
//! 届时本文件将改为 `#![cfg(windows)]` 门控的真实实现模块。

pub mod windows_impl {
    // M1 迁入 Win32 实现：struct WinScreenshotProvider / WinHotkeyProvider，
    // 分别 impl fs_platform::ScreenshotProvider / HotkeyProvider。
}
