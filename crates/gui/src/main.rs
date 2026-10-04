//! `fs-gui`：**主程序**主窗体（Tauri 2）。
//!
//! 启动流程：
//! 1. 解析命令行（`--console` 兼容开始菜单快捷方式）
//! 2. 解析用户配置
//! 3. 注册全局动作热键（`selection_translate` 默认 `Alt+Q`、`fullscreen_translate` 默认 `Ctrl+Alt+O`；见 `main_window::reload_global_hotkeys`）
//! 4. 创建系统托盘
//! 5. 启动 Tauri（主窗体 960x640，四页面由前端渲染）
//!
//! 2026-10-03：框选（`region_translate` / overlay 选区窗口）已整体下线。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod log;
mod selftest;
mod window;

use tauri::{Builder, Manager};

use window::main_window::AppState;

fn main() {
    // 必须在最前面：装上 panic hook，让「静默崩溃」至少留下现场。
    // 真机 `Ctrl+Alt+O` 曾无 dump、无日志地退出进程，没有这条日志就永远是猜测。
    log::init();

    // 真机自测开关（纯 Rust，见 selftest 模块）：跑完自动 exit(0)。
    let selftest_region = std::env::args().any(|a| a == "--selftest=region");

    let app = Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::set_hotkeys_suspended,
            commands::get_status,
            commands::ping,
            commands::list_engines,
            commands::test_engine,
            commands::translate_text,
            commands::screenshot_translate,
            commands::translate_image_bytes,
            commands::chat,
            commands::get_history,
            commands::get_result,
            commands::clear_history,
        ])
        .setup(move |app| {
            log::line("setup: begin");
            // 显式显示主窗体（不依赖声明式配置的默认行为）。
            // 只调 show()，**绝不**调 set_focus()：ADR-005 已确认 set_focus() 与
            // withGlobalTauri 组合曾触发 0xcfffffff 崩溃，禁止再次引入。
            if let Some(w) = app.get_webview_window(window::main_window::MAIN_WINDOW_LABEL) {
                let _ = w.show();
            }

            // 创建托盘
            window::tray::create_tray(app.handle())?;

            // 注册全局动作热键（`selection_translate` 默认 Alt+Q，`fullscreen_translate` 默认 Ctrl+Alt+O）。
            // 失败不阻断启动：热键被占用/组合非法时降级为仅应用内热键。
            let st = app.state::<AppState>();
            match st.reload_global_hotkeys(app.handle()) {
                Ok(()) => log::line("setup: hotkeys registered"),
                Err(e) => {
                    log::line(&format!("setup: hotkey register failed: {e}"));
                    eprintln!("warn: 全局热键注册失败（应用继续运行）: {e}");
                }
            }

            // OCR 启动预热：后台线程做一次空图推理，让 ONNX Runtime 完成会话初始化与
            // 内存池预热，避免首次热键翻译时耗时突增。只短暂持锁；PlaceholderOcr
            // 返回空属正常（模型缺失降级场景），错误一律忽略。
            {
                let warmup_handle = app.handle().clone();
                std::thread::spawn(move || {
                    crate::log::line("warmup: begin");
                    let img = fs_core::types::RawImage {
                        width: 64,
                        height: 64,
                        data: vec![255; 64 * 64 * 4],
                        format: fs_core::types::PixelFormat::Bgra,
                    };
                    let st: tauri::State<AppState> = warmup_handle.state();
                    let _ = st.ocr.lock().unwrap().recognize(&img);
                    crate::log::line("warmup: done");
                });
            }

            log::line("setup: done");

            // 自测必须在热键注册之后启动，否则合成的 Alt+Q 无人接收
            if selftest_region {
                selftest::spawn_region_selftest(app.handle());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭主窗体 = 退出应用（与旧项目行为一致）
            if window.label() == window::main_window::MAIN_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    // 交由前端确认是否最小化到托盘；骨架阶段直接退出
                    window.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");

    app.run(|_app_handle, _event| {});
}