//! 剪贴板兜底取词路径 —— UIA 读不到选区时使用。
//!
//! 原理：合成一次 `Ctrl+C` 让目标应用把选区放进剪贴板，再读 `CF_UNICODETEXT`。
//!
//! # 两个必须知道的坑（设计 §2.6）
//!
//! ##坑 1：禁止恢复原剪贴板内容
//!
//! Office 等应用会在剪贴板里放**指向自身内部数据的指针**。若我们覆盖剪贴板，
//! 原数据会被释放；之后再"恢复"旧内容，该指针即悬空 → **Office 崩溃**。
//! （社区已多次报告此问题，对应 Office 的「读取剪贴板后崩溃」现象。）
//!
//! 因此本模块**只读不写回**。代价是划词会覆盖用户剪贴板 —— 这是已知取舍，
//! 会在设置页明示。**任何"恢复剪贴板"的实现都是错的，不要加。**
//!
//! ## 坑 2：必须校验 Ctrl+C 是否真的生效
//!
//! 目标应用可能不响应 `WM_COPY`（游戏、无文本焦点的控件）。此时剪贴板内容
//! **不会变化**，若不校验就会把用户**原有的剪贴板内容**当成划词结果 ——
//! 表现为"划词翻出了我上次复制的东西"，是典型的幽灵 bug。
//!
//! 解法：用 `GetClipboardSequenceNumber()` 在复制前后比对，序列号变化
//! 才说明剪贴板被写过。
//!
//! # 另一个必要前置：释放所有修饰键
//!
//! 用户可能正按住 Ctrl/Alt/Shift 划词。若直接发 `Ctrl+C`，会与残留修饰键
//! 组合成 `Ctrl+Alt+C` 等，触发目标应用的其它快捷键（如 Word 的
//! `Ctrl+Alt+C` 插入公式）。故发送前先逐个释放。

// 仅测试用（wcslen 的 null 指针用例）；非测试构建不需要。
#[cfg(test)]
use std::ptr;

use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_C, VK_CONTROL, VK_LCONTROL, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RCONTROL, VK_RSHIFT,
    VK_RWIN, VK_SHIFT,
};

use crate::error::{AppError, Result};
use crate::wordpick::text_is_usable;

/// 合成的按键序列之间间隔（毫秒）。
///
/// 太短则目标应用来不及处理 `WM_KEYDOWN` → Ctrl+C 被忽略；
/// 太长则划词有可感知的延迟。30ms 是兼顾两者的经验值。
const KEY_GAP_MS: u64 = 30;

/// Ctrl+C 后等待剪贴板被写入的时间。
///
/// 剪贴板写入是异步的（目标应用投递 WM_COPY 后稍作处理才SetData），
/// 立即读可能读不到。这里做一次短等待重试。
const CLIPBOARD_WAIT_MS: u64 = 120;
const CLIPBOARD_POLL_STEP_MS: u64 = 20;

/// 通过合成 Ctrl+C 读取当前划选文本。
///
/// **会覆盖用户剪贴板**（见模块级坑 1），调用方需在 UI 上明示。
pub fn read_selection_via_copy() -> Result<String> {
    // 1. 记录序列号：用于判断复制是否真的发生
    // SAFETY: 纯查询，无副作用
    let seq_before = unsafe { GetClipboardSequenceNumber() };

    // 2. 释放所有修饰键，避免与 Ctrl+C 组合成其它快捷键
    release_modifiers()?;

    // 3. 合成 Ctrl+C
    send_ctrl_c()?;

    // 4. 等剪贴板被写入并读取（异步）
    let text = wait_for_clipboard_text(seq_before)?;

    if !text_is_usable(&text) {
        return Err(AppError::Config("剪贴板内容为空".to_string()));
    }
    Ok(text)
}

/// 释放所有修饰键，避免与 `Ctrl+C` 组合成其它快捷键。
///
/// 左右两侧都要发：用户可能按住右 Shift，此时只发左 Shift 的 KEYUP 无效。
///
/// `CapsLock` 在 `windows` 0.58 中**未导出** `VK_CAPSLOCK` 常量，
/// 且它不参与组合快捷键（不会产生 `Ctrl+Shift+C` 之类），故不处理。
fn release_modifiers() -> Result<()> {
    const KEYS: [VIRTUAL_KEY; 9] = [
        VK_LSHIFT,
        VK_RSHIFT,
        VK_SHIFT,
        VK_LCONTROL,
        VK_RCONTROL,
        VK_CONTROL,
        VK_MENU,
        VK_LWIN,
        VK_RWIN,
    ];

    let inputs: Vec<INPUT> = KEYS.iter().map(|&vk| key_input(vk, false)).collect();
    send_inputs(&inputs)
}

/// 合成一次 Ctrl+C。
fn send_ctrl_c() -> Result<()> {
    send_inputs(&[key_input(VK_CONTROL, true), key_input(VK_C, true)])?;
    std::thread::sleep(std::time::Duration::from_millis(KEY_GAP_MS));
    send_inputs(&[key_input(VK_C, false), key_input(VK_CONTROL, false)])
}

/// 构造单个键盘 INPUT。
fn key_input(vk: VIRTUAL_KEY, down: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                // 只走 VIRTUAL_KEY 路径，不设 KEYEVENTF_SCANCODE。
                // ⚠️ KEYUP 标志漏掉会导致按键"卡住"（最典型的 SendInput bug）。
                dwFlags: if down {
                    KEYBD_EVENT_FLAGS(0)
                } else {
                    KEYEVENTF_KEYUP
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// 发送 INPUT 序列。
fn send_inputs(inputs: &[INPUT]) -> Result<()> {
    // SAFETY: inputs 构造正确，长度为 0 时 SendInput 约定返回 0（视为失败）
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err(AppError::Config(format!(
            "SendInput 只发送了 {sent}/{} 个事件（可能被 UIPI 拦截）",
            inputs.len()
        )))
    }
}

/// 等待剪贴板内容变化，变化后读取其中的 Unicode 文本。
///
/// 剪贴板写入是**异步**的（目标应用收到 WM_COPY 后才SetData），故轮询等待。
///
/// 序列号不变说明 Ctrl+C 没生效（目标应用不响应 WM_COPY），
/// 此时**必须报错**而非返回旧内容 —— 否则会把用户原有剪贴板当成划词结果。
fn wait_for_clipboard_text(seq_before: u32) -> Result<String> {
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(CLIPBOARD_WAIT_MS);

    loop {
        // SAFETY: 纯查询，无副作用
        let seq_now = unsafe { GetClipboardSequenceNumber() };

        if seq_now != seq_before {
            // 剪贴板已被写入。OpenClipboard 的 hwndNewOwner 传 None（NULL）
            // 表示不关联窗口 —— 对"读他人剪贴板"是文档允许的用法。
            // SAFETY: NULL owner 合法
            unsafe { OpenClipboard(None) }
                .map_err(|e| AppError::Config(format!("OpenClipboard 失败: {e}")))?;

            // 读取必须在 CloseClipboard 之前完成
            // SAFETY: 刚成功 OpenClipboard，满足 read_unicode_text_inner 的前置
            let result = unsafe { read_unicode_text_inner() };

            // SAFETY: 与上面的 OpenClipboard 配对；读取已完成
            unsafe { CloseClipboard() }.ok();

            return result;
        }

        if std::time::Instant::now() >= deadline {
            return Err(AppError::Config(
                "Ctrl+C 未改变剪贴板（目标应用可能不响应复制）".to_string(),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(CLIPBOARD_POLL_STEP_MS));
    }
}

/// 在剪贴板已打开的前提下读取文本。调用方负责 CloseClipboard。
///
/// # Safety
///
/// 必须已成功 `OpenClipboard` 且尚未 `CloseClipboard`。
unsafe fn read_unicode_text_inner() -> Result<String> {
    // SAFETY: 依赖调用方已打开剪贴板
    let handle = unsafe { GetClipboardData(CF_UNICODETEXT.0 as u32) }
        .map_err(|e| {
            AppError::Config(format!("剪贴板无 Unicode 文本（Ctrl+C 可能未生效）: {e}"))
        })?;

    // GetClipboardData 返回 HGLOBAL；需 GlobalLock 映射后才能读
    // SAFETY: handle 来自 GetClipboardData，是有效的全局内存句柄
    let locked: HGLOBAL = HGLOBAL(handle.0);
    // SAFETY: locked 是有效的 HGLOBAL
    let ptr = unsafe { GlobalLock(locked) };
    if ptr.is_null() {
        return Err(AppError::Config("GlobalLock 失败".to_string()));
    }

    // SAFETY: GlobalSize 对 CF_UNICODETEXT 句柄可返回 0（大小未知），
    // 此时不能直接按 0 长度切片。CF_UNICODETEXT 约定以 NUL 双字节结尾，
    // 故在 0 情况下靠 NUL 终止（见下方 scan）。
    let byte_len = unsafe { GlobalSize(locked) };

    // NUL 安全的读取：优先用 GlobalSize 限定，否则回退到扫描 NUL。
    // 剪贴板内存不保证在 size 边界外可读，故只在已知范围内扫描。
    let slice_ptr = ptr as *const u16;
    let max_units = byte_len / std::mem::size_of::<u16>();
    let mut out = String::new();
    for i in 0..max_units {
        // SAFETY: i< max_units 越界读风险由 GlobalSize 保证
        let unit = unsafe { *slice_ptr.add(i) };
        if unit == 0 {
            break; // 命中 NUL 终止符
        }
        // SAFETY: 逐u16 push 不会在中间位置分裂 UTF-16 代理对，
        // 因为代理对的两个 u16 都非 0，会被一起收集
        match char::from_u32(unit as u32) {
            Some(c) => out.push(c),
            // 孤立代理项：跳过而非 panic
            None => continue,
        }
    }

    // SAFETY: 与 GlobalLock 配对
    unsafe { GlobalUnlock(locked) }.ok();

    if out.is_empty() {
        // GlobalSize 返回 0 的极端情况：退化到 wcslen
        // SAFETY: 指针仍锁定且 NUL 终止
        let fallback = unsafe { wcslen(ptr as *const u16) };
        if fallback > 0 {
            // SAFETY: 长度已由 wcslen 确认
            let s = unsafe {
                std::slice::from_raw_parts(ptr as *const u16, fallback)
            };
            return Ok(String::from_utf16_lossy(s));
        }
        return Err(AppError::Config("剪贴板文本为空".to_string()));
    }

    Ok(out)
}

/// 计算 NUL 结尾的 UTF-16 串长度。
///
/// # Safety
///
/// `ptr` 必须指向 NUL 结尾的 u16 序列。
unsafe fn wcslen(ptr: *const u16) -> usize {
    if ptr.is_null() {
        return 0;
    }
    let mut len = 0usize;
    // SAFETY: 逐个读直到 NUL；剪贴板内存保证 NUL 终止
    while unsafe { *ptr.add(len) } != 0 {
        len += 1;
        if len > 1_000_000 {
            // 安全阀：防病态输入导致死循环
            break;
        }
    }
    len
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wcslen_counts_until_nul() {
        // SAFETY: 测试构造的数组是 NUL 结尾的合法 UTF-16 序列
        let data: [u16; 5] = [b'h' as u16, b'i' as u16, 0, b'x' as u16, b'y' as u16];
        // SAFETY: 传入有效指针
        assert_eq!(unsafe { wcslen(data.as_ptr()) }, 2);
    }

    #[test]
    fn wcslen_handles_null_ptr() {
        // SAFETY: 显式传 null，函数内已判空
        assert_eq!(unsafe { wcslen(ptr::null()) }, 0);
    }

    #[test]
    fn key_input_sets_keyup_flag_correctly() {
        // KEYEVENTF_KEYUP 写错会导致按键卡住（最典型的 SendInput bug）
        let down = key_input(VK_C, true);
        let up = key_input(VK_C, false);
        // SAFETY: INPUT 的匿名联合字段均可读
        unsafe {
            assert_eq!(down.r#type, INPUT_KEYBOARD);
            assert_eq!(
                down.Anonymous.ki.dwFlags,
                KEYBD_EVENT_FLAGS(0),
                "按下不应带 KEYUP"
            );
            assert_eq!(up.Anonymous.ki.dwFlags, KEYEVENTF_KEYUP);
        }
    }

    #[test]
    fn key_input_preserves_virtual_key() {
        // 虚拟键码写错会合成出别的键
        // SAFETY: 读取自有数据的字段
        let input = key_input(VK_C, true);
        // SAFETY: INPUT 的匿名联合字段均可读
        assert_eq!(unsafe { input.Anonymous.ki.wVk }, VK_C);
    }
}
