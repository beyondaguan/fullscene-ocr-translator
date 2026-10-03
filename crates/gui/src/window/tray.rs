//! 系统托盘（Tauri 2 原生实现）。
//!
//! 菜单项：
//! - **显示主窗体**：把主窗体置前（最小化到托盘后的恢复入口）
//! - **退出**：退出应用
//!
//! 单击托盘图标（左键）同样唤起主窗体。首启气泡见 `maybe_show_first_run_balloon`。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// 创建托盘图标 + 菜单。
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗体", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("全场景OCR翻译")
        .menu(&menu)
        .show_menu_on_left_click(false);

    // 必须显式设置托盘图标：tauri 的 builder 不回退到应用默认图标，
    // 缺省时底层 tray-icon crate 在 Windows 上会创建空白/透明图标。
    // 图标不可用时仅告警跳过，不 panic 崩溃应用。
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        crate::log::line("tray: app.default_window_icon() 为空，托盘图标将保持空白");
    }

    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    maybe_show_first_run_balloon(app);
    Ok(())
}

/// 把主窗体显示并置前。
pub fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 首次启动标记：`%APPDATA%/FullSceneOCR/.first_run`
fn first_run_marker(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .map(|p| p.join(".first_run"))
        .unwrap_or_else(|_| std::path::PathBuf::from(".first_run"))
}

/// 首次启动时弹一条系统气泡（Tauri 托盘无原生 balloon API，通过 shell 通知占位；
/// 完整实现见旧项目 `tray.rs` 的 Shell_NotifyIconW 方案）。
fn maybe_show_first_run_balloon(_app: &AppHandle) {
    // TODO: 用 windows Shell_NotifyIconW(NIF_INFO) 实现系统气泡（需自建隐藏窗口）。
    // 旧项目已验证该方案可用；此处先写标记，避免每次启动重复尝试。
    let marker = first_run_marker(_app);
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(marker.parent().unwrap_or(std::path::Path::new("")));
    let _ = std::fs::write(&marker, "1");
}