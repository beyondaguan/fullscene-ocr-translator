//! 真机自测（`--selftest=region`）：**纯 Rust**，不依赖 Python / 外部脚本。
//!
//! 用途：无人值守地验证「Alt+Q → 出现十字框选 → 拖框 → OCR → 翻译回填」整条链路。
//! 做法是合成输入：`SendInput` 发全局热键 `Alt+Q`（默认键见 `config::DEFAULT_HOTKEYS`），
//! 再用绝对坐标合成鼠标拖拽，
//! 全程不需要人动手，也不需要截图肉眼比对。
//!
//! 运行：
//! ```text
//! cargo build -p fs-gui && ./target/debug/fs-gui.exe --selftest=region
//! ```
//! 判定：看 stdout 的 `SELFTEST_RESULT=` 行 —— `ok` 表示拿到了区域与译文。

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, VK_MENU,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, SW_SHOWNORMAL,
};

use crate::window::main_window::AppState;

/// 自测要框的区域（虚拟屏像素坐标）：主屏左上 800x400。
///
/// 刻意避开主窗体——主窗体默认居中（约 480~1440 x 220~860），
/// 框到它就会 OCR 出本工具自己的中文界面，验证不了真实翻译。
const PICK_X0: i32 = 100;
const PICK_Y0: i32 = 100;
const PICK_X1: i32 = 900;
const PICK_Y1: i32 = 500;

/// 自测期间把主窗体挪到右下角，给框选区让出干净的屏幕内容。
fn park_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(crate::window::main_window::MAIN_WINDOW_LABEL) {
        let _ = w.set_position(tauri::PhysicalPosition::new(950, 430));
        say("main window parked to bottom-right");
    }
}

/// 启动自测线程。必须在**热键注册之后**调用，否则合成键没人接收。
pub fn spawn_region_selftest(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        say("SELFTEST_BEGIN region");
        // 先在默认浏览器打开英文测试页：否则框选区里是本工具自己的中文界面，
        // 走到「中文→中文」分支（MyMemory/Google 403），验证不到真实翻译。
        park_main_window(&app);
        open_test_page();
        thread::sleep(Duration::from_secs(12));

        say("send Alt+Q (selection_translate)");
        key_combo(&[VK_MENU.0, b'Q' as u16]);
        thread::sleep(Duration::from_secs(3)); // 等框选窗口创建 + 抓屏冻结

        say(&format!("drag {PICK_X0},{PICK_Y0} -> {PICK_X1},{PICK_Y1}"));
        mouse_move_to(PICK_X0, PICK_Y0);
        thread::sleep(Duration::from_millis(200));
        mouse_left_down();
        // 分几步移动，模拟真实拖拽（也让 WM_MOUSEMOVE 有机会刷新选框）
        for i in 1..=5 {
            let x = PICK_X0 + (PICK_X1 - PICK_X0) * i / 5;
            let y = PICK_Y0 + (PICK_Y1 - PICK_Y0) * i / 5;
            mouse_move_to(x, y);
            thread::sleep(Duration::from_millis(120));
        }
        thread::sleep(Duration::from_millis(200));
        mouse_left_up();
        say("mouse released; waiting for OCR + translate");

        // 轮询忙标记而不是死等固定秒数：管线耗时随网络在 2~40s 波动，
        // 固定值要么读早了（拿到空结果），要么白等。
        let st_busy = app.state::<AppState>();
        for _ in 0..120 {
            if !st_busy.pipeline_busy.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_millis(500));
        }

        let st = app.state::<AppState>();
        let (orig_len, trans, updated) = {
            let g = st.gui_result.lock().unwrap();
            (g.original.chars().count(), g.translation.clone(), g.updated_at_ms)
        };
        say(&format!(
            "SELFTEST_RESULT={} original_chars={} updated_at_ms={} translation={}",
            if updated > 0 && !trans.is_empty() { "ok" } else { "no-result" },
            orig_len,
            updated,
            first_line(&trans)
        ));
        say("SELFTEST_END");
        app.exit(0);
    });
}

/// 用默认浏览器打开英文测试页（`ShellExecuteW` 走系统关联，无需知道浏览器路径）。
fn open_test_page() {
    // 必须是普通（非 raw）字符串：raw 字符串里 `\0` 是字面两个字符而非 NUL 终止符，
    // `\\` 也会变成两个反斜杠。上一版正是因此让 ShellExecuteW 返回 SE_ERR_FILENOTFOUND(2)。
    let path: Vec<u16> = "D:\\g\\fullscene-ocr-translator\\tests-data\\ocr-page.html\0"
        .encode_utf16()
        .collect();
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    unsafe {
        let r = ShellExecuteW(
            None,
            windows::core::PCWSTR(verb.as_ptr()),
            windows::core::PCWSTR(path.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        );
        say(&format!("open_test_page ShellExecuteW -> {:?}", r.0));
    }
}

/// 同时打印到 stdout 与日志文件（GUI 构建没有控制台时，文件是唯一现场）。
fn say(msg: &str) {
    println!("{msg}");
    crate::log::line(&format!("selftest: {msg}"));
}

/// 取首行，避免整段译文刷屏。
fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(120).collect()
}

/// 依次按下再逆序松开一组虚拟键。
fn key_combo(keys: &[u16]) {
    for vk in keys {
        send_key(*vk, false);
        thread::sleep(Duration::from_millis(40));
    }
    for vk in keys.iter().rev() {
        send_key(*vk, true);
        thread::sleep(Duration::from_millis(40));
    }
}

fn send_key(vk: u16, up: bool) {
    unsafe {
        let mut input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0::default(),
        };
        input.Anonymous.ki = KEYBDINPUT {
            wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(vk),
            wScan: 0,
            dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
            time: 0,
            dwExtraInfo: 0,
        };
        let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

/// 把虚拟屏坐标归一化到 0..65535 后合成绝对移动（多显示器必须带 VIRTUALDESK）。
fn mouse_move_to(x: i32, y: i32) {
    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1);
        let nx = ((x - vx) * 65535) / vw;
        let ny = ((y - vy) * 65535) / vh;
        send_mouse(nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
    }
}

fn mouse_left_down() {
    send_mouse(0, 0, MOUSEEVENTF_LEFTDOWN);
}

fn mouse_left_up() {
    send_mouse(0, 0, MOUSEEVENTF_LEFTUP);
}

fn send_mouse(dx: i32, dy: i32, flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS) {
    unsafe {
        let mut input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0::default(),
        };
        input.Anonymous.mi = MOUSEINPUT {
            dx,
            dy,
            mouseData: 0,
            dwFlags: flags,
            time: 0,
            dwExtraInfo: 0,
        };
        let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}
