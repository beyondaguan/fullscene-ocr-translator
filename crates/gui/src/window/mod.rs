//! 主窗体窗口模块（Tauri 2）。
//!
//! - [`main_window`]：AppState + 截图翻译管线
//! - [`tray`]：系统托盘
//! - [`region_picker`]：十字形框选（**纯 Win32 + GDI**，2026-10-03 重建）
//!
//! 框选沿革：曾用「全屏透明 + 无边框 + 置顶」的 **WebView2** 窗口（`overlay`），
//! 从未真机验证通过且是崩溃源，1.26 下线；现改为纯 Win32 窗口 + GDI 自绘，
//! 不经过 WebView2 / React，崩溃面与前者完全不同。

pub mod main_window;
pub mod region_picker;
pub mod tray;
