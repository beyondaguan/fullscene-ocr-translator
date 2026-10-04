//! 全局热键（M6）。Windows `RegisterHotKey` + 独立线程消息循环。
//!
//! 支持按动作注册多组全局热键（见 [`HotkeyAction`]），`WM_HOTKEY` 按 id 分发到对应动作回调。
//! 改热键时先 [`HotkeyHandle::stop`] 再重新 `spawn_hotkey_loop`（热重载，无需重启进程）。

use crate::error::{AppError, Result};
use std::sync::mpsc;
use std::thread;
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{HOT_KEY_MODIFIERS, RegisterHotKey, UnregisterHotKey};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, MSG, PostThreadMessageW, WM_HOTKEY, WM_QUIT,
};

/// 单个全局动作热键：注册 id + 组合键文本 + 触发回调。
/// id 在同一线程内必须唯一（1..=0xBFFF），用于 `WM_HOTKEY` 分发时识别动作。
pub struct HotkeyAction {
    pub id: u32,
    pub combo: String,
    pub on_trigger: Box<dyn Fn() + Send + 'static>,
}

/// 解析 "Alt+Q" / "Ctrl+Alt+O" / "Alt+1" / "Ctrl+F5" 形态，返回 (modifiers 位掩码, 主键虚拟键码)。
///
/// 主键支持三类（2026-10-03 扩：原先只认字母，导致 `Alt+1` 被判非法、注册静默失败）：
/// - 单个字母/数字 → 直接取其 ASCII 码（与 `VK_*` 兼容，如 'Q'=0x51、'1'=0x31）
/// - `F1`~`F24` → `VK_F1`(0x70) + n - 1
/// - 其余（含空）→ 报 `Config` 错误，由调用方降级为「不注册」而非崩溃
fn parse_combo(combo: &str) -> std::result::Result<(u32, u16), AppError> {
    let mut modifiers = 0u32;
    let mut key: Option<u16> = None;
    for part in combo.split('+') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        let upper = p.to_ascii_uppercase();
        match upper.as_str() {
            "ALT" => modifiers |= 0x0001,
            "CTRL" | "CONTROL" => modifiers |= 0x0002,
            "SHIFT" => modifiers |= 0x0004,
            "WIN" | "SUPER" => modifiers |= 0x0008,
            _ => {
                if let Some(vk) = parse_primary_key(&upper) {
                    key = Some(vk);
                } else {
                    return Err(AppError::Config(format!("无法解析热键组合: {combo}")));
                }
            }
        }
    }
    let k = key.ok_or_else(|| AppError::Config(format!("热键组合缺少主键: {combo}")))?;
    Ok((modifiers, k))
}

/// 主键文本 → 虚拟键码。支持 字母 / 数字 / F1~F24。
fn parse_primary_key(upper: &str) -> Option<u16> {
    // 功能键：F1 = VK_F1(0x70)
    if let Some(rest) = upper.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u16>() {
            if (1..=24).contains(&n) {
                return Some(0x70 + n - 1);
            }
        }
        return None;
    }
    if upper.len() != 1 {
        return None;
    }
    let c = upper.chars().next()?;
    if c.is_ascii_alphanumeric() {
        Some(c as u16)
    } else {
        None
    }
}

/// 热键句柄：持有监听线程 ID，可主动停止（注销热键并结束线程）。
/// 用于控制台改热键后热重载，无需重启进程。
/// 注册失败时为「空句柄」（`stop()` 是无操作），应用照常运行。
pub struct HotkeyHandle {
    thread_id: Option<u32>,
}

/// 解析完成的热键动作：(注册id, modifiers 位掩码, 主键虚拟键码, 触发回调)。
type ParsedHotkey = (u32, u32, u16, Box<dyn Fn() + Send + 'static>);

impl HotkeyHandle {
    /// 注销全局热键并结束监听线程（向线程投递 WM_QUIT，`GetMessageW` 返回 0 退出循环）。
    pub fn stop(&self) {
        if let Some(tid) = self.thread_id {
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
}

/// 注册一组全局动作热键并在独立线程监听 `WM_HOTKEY`，按 `id` 分发到对应动作的 `on_trigger`。
///
/// 注册失败仅告警、不阻断主流程（降级为仅响应 Native Messaging）。个别组合键若被占用
/// 会单独失败并跳过，不影响其余动作。返回 [`HotkeyHandle`]，改热键时先 `stop()` 再重新
/// `spawn_hotkey_loop`（热重载，无需重启进程）。
///
/// ## `on_warn` 的必要性
///
/// 原本三处告警都用 `eprintln!`。但主程序是 **windows 子系统程序、没有控制台**，
/// `eprintln!` 的输出谁都看不到——真机表现为「热键按了没反应」，完全无法诊断
/// （2026-10-04 实测：用户报 `Ctrl+Alt+E` 无效，而 `RegisterHotKey` 失败的唯一线索
/// 就写在这条被丢弃的 `eprintln!` 里）。
/// `on_warn` 让调用方（`fs-gui`）把告警转写进 `%APPDATA%/FullSceneOCR/logs/fs-gui.log`。
pub fn spawn_hotkey_loop(actions: Vec<HotkeyAction>) -> Result<HotkeyHandle> {
    spawn_hotkey_loop_with_warn(actions, |msg| eprintln!("{msg}"))
}

/// [`spawn_hotkey_loop`] 的带告警回调版本。`on_warn` 会在注册失败 / 回调 panic /
/// 线程未就绪时被调用。
pub fn spawn_hotkey_loop_with_warn(
    actions: Vec<HotkeyAction>,
    on_warn: impl Fn(String) + Send + Sync + 'static,
) -> Result<HotkeyHandle> {
    // 先全部解析，任一非法组合键直接返回 Err（不启动线程）。
    let parsed: Vec<ParsedHotkey> = actions
        .into_iter()
        .map(|a| {
            let (m, k) = parse_combo(&a.combo)?;
            Ok((a.id, m, k, a.on_trigger))
        })
        .collect::<Result<Vec<_>>>()?;

    let (id_tx, id_rx) = mpsc::channel::<u32>();
    // 告警回调要被线程内两处（注册失败 / 回调 panic）与主线程（线程未就绪）共用，
    // 故用 Arc 共享——`impl Fn` 不可 clone。
    let on_warn = std::sync::Arc::new(on_warn);
    let on_warn_thread = std::sync::Arc::clone(&on_warn);
    let on_warn_reg = std::sync::Arc::clone(&on_warn);
    let on_warn_main = std::sync::Arc::clone(&on_warn);
    thread::spawn(move || {
        unsafe {
            // 逐个注册；被占用（0x80070581）等失败仅告警跳过，不阻断其余动作。
            for (id, modifiers, vk, _) in &parsed {
                if let Err(e) = RegisterHotKey(
                    None,
                    *id as i32,
                    HOT_KEY_MODIFIERS(*modifiers),
                    *vk as u32,
                ) {
                    on_warn_reg(format!(
                        "注册全局热键 id={id} 失败（可能被占用，该组合键不生效）: {e}"
                    ));
                }
            }
            // 把线程 ID 回传，供 stop() 投递 WM_QUIT。
            let _ = id_tx.send(GetCurrentThreadId());

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message == WM_HOTKEY {
                    let id = msg.wParam.0 as u32;
                    if let Some(action) = parsed.iter().find(|(i, _, _, _)| *i == id) {
                        // 回调必须被 catch_unwind 包住：
                        // ① 回调里跑的是「GDI 截图 + ONNX 推理 + 网络翻译」这种长耗时脏活，
                        //    一旦 panic，监听线程会直接死掉 → 全局热键此后永久失效（真机上
                        //    表现为「按了没反应」，极易被误判为「进程崩溃」）；
                        // ② 捕获后线程继续存活，热键仍可再次触发。
                        let cb = &action.3;
                        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(cb));
                        if r.is_err() {
                            on_warn_thread(format!("热键 id={id} 回调 panic，已捕获，监听线程继续存活"));
                        }
                    }
                }
                let _ = DispatchMessageW(&msg);
            }
            for (id, _, _, _) in &parsed {
                let _ = UnregisterHotKey(None, *id as i32);
            }
        }
    });
    // 阻塞等待线程上报 ID，确保 stop() 前线程已就绪。
    // 拿不到 ID（线程直接退出）时——按模块契约降级为「空句柄」，返回 Ok 而非 Err：
    // 热键是便利功能，绝不能阻断应用启动。
    let thread_id = id_rx.recv().ok();
    if thread_id.is_none() {
        on_warn_main("全局热键未生效（可能被其他程序占用），应用继续运行（应用内热键仍可用）".into());
    }
    Ok(HotkeyHandle { thread_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_alt_q() {
        let (m, k) = parse_combo("Alt+Q").unwrap();
        assert_eq!(m, 0x0001);
        assert_eq!(k, b'Q' as u16);
    }

    #[test]
    fn parse_ctrl_alt_s() {
        let (m, k) = parse_combo("Ctrl+Alt+S").unwrap();
        assert_eq!(m, 0x0001 | 0x0002);
        assert_eq!(k, b'S' as u16);
    }

    #[test]
    fn parse_invalid_combo_errors() {
        assert!(parse_combo("").is_err());
        assert!(parse_combo("Alt+").is_err());
        assert!(parse_combo("Foo+Q").is_err());
    }

    /// 回归：Alt+1 曾因主键只认字母而被判非法 → 框选热键静默不注册。
    #[test]
    fn parse_numeric_primary_key() {
        let (m, k) = parse_combo("Alt+1").unwrap();
        assert_eq!(m, 0x0001);
        assert_eq!(k, b'1' as u16);
    }

    #[test]
    fn parse_function_key() {
        let (m, k) = parse_combo("Ctrl+F5").unwrap();
        assert_eq!(m, 0x0002);
        assert_eq!(k, 0x70 + 4); // VK_F5
    }

    #[test]
    fn parse_out_of_range_function_key_errors() {
        assert!(parse_combo("F25").is_err());
        assert!(parse_combo("F0").is_err());
    }
}
