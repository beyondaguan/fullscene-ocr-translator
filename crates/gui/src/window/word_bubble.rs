//! 划词小气泡 + 结果浮窗（纯 Win32 + GDI，阶段 B1/B2）。
//!
//! # 为什么不用 WebView2
//! 与 [`super::region_picker`] 同理：1.26 已确认「全屏 + 透明 + 无边框 + 置顶」的
//! **WebView2** 窗口是崩溃源。本模块是纯 Win32 窗口 + GDI 自绘，
//! 没有 WebView2 / React 参与，崩溃面与前者完全不同。
//!
//! # 「不抢焦点」是硬需求，不是体验优化（重要，勿简化）
//!
//! UIA 取词读的是**前台窗口**状态（[`fs_core::wordpick`] 的
//! `IUIAutomation::GetFocusedElement`）。若浮窗在显示时抢走焦点，
//! 目标应用立刻失焦，**button 模式的前提（划词后目标应用仍在前台）直接被破坏**——
//! 气泡显示的这一刻恰恰是用户还没决定要不要翻的时候，抢焦点等于强行替他做决定，
//! 且此时再取词已拿不到原来的选区。
//!
//! 因此必须**三件套同时**用，缺一不可：
//! 1. [`WS_EX_NOACTIVATE`] —— 窗口不进入前台激活循环
//! 2. [`SW_SHOWNOACTIVATE`] —— 显示时不激活（**只写 1 配 [`ShowWindow(hwnd, SW_SHOW)`] 仍会激活**）
//! 3. `WM_MOUSEACTIVATE` 返回 [`MA_NOACTIVATE`] —— 鼠标点击也不激活
//!
//! # 因为没有焦点，Esc 必须轮询
//!
//! 用户按 Esc 时焦点在**目标应用**，本窗口收不到 [`WM_KEYDOWN`]。
//! 故 Esc 用 [`GetAsyncKeyState`] 轮询实现，并由 [`SetTimer`] 提供节拍。
//! 轮询**必须去抖**（按下→抬起算一次），否则一次 Esc 按住期间多帧命中会重复关闭。
//!
//! # 坐标
//!
//! 全程用 [`GetCursorPos`]（虚拟屏物理坐标），**不混用 `lParam`**
//! （后者需按 DPI 换算，是错位主因）。与 `region_picker` 同源。
//!
//! 定位逻辑收敛在 [`locate_bubble`] 一个函数里：将来若要精确跟随选区
//! （需改 `wordpick::uia` 取 range 的 `GetBoundingRectangles`，注意是**复数**、
//! 返回 SAFEARRAY，见 `docs/划词取词设计.md`），只改这一个函数即可。

use std::ptr;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW, CreateSolidBrush,
    DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, SelectObject, SetBkMode,
    SetTextColor, DEFAULT_CHARSET, DT_CENTER, DT_LEFT, DT_SINGLELINE, DT_VCENTER,
    DT_WORDBREAK, FF_DONTCARE, FW_NORMAL, OUT_DEFAULT_PRECIS, SRCCOPY, TRANSPARENT,
};
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, KillTimer,
    PostQuitMessage, RegisterClassW, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    TranslateMessage, UnregisterClassW, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, MA_NOACTIVATE,
    MSG, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE,
    WM_DESTROY, WM_ERASEBKGND, WM_LBUTTONDOWN, WM_MOUSEACTIVATE, WM_PAINT, WM_TIMER,
    WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

use super::super::log;

/// 气泡直径（逻辑像素，未乘 DPI）。
const BUBBLE_SIZE: i32 = 28;
/// 气泡与锚点的间距（逻辑像素）。
const BUBBLE_GAP: i32 = 10;
/// 结果窗最大宽/高（逻辑像素）。
const RESULT_MAX_W: i32 = 460;
const RESULT_MAX_H: i32 = 320;
/// 结果窗内边距（逻辑像素）。
const RESULT_PAD: i32 = 12;
/// 关闭按钮边长（逻辑像素）。
const CLOSE_BTN: i32 = 22;
/// Esc / 点击外部的轮询间隔（毫秒）。
const POLL_MS: u32 = 50;
/// `SetTimer` 的定时器 id。
const TIMER_ID: usize = 0x5177;

/// 主题色（BGR，符合 `COLORREF` 布局）。
const COLOR_ACCENT: u32 = 0x00FF_7716; // #1677ff 蓝
const COLOR_PANEL: u32 = 0x0028_2019; // #191c28 深底
const COLOR_TEXT: u32 = 0x00FF_FFFF; // #ffffff 白
const COLOR_DIM: u32 = 0x00C8_B4A0; // #a0b4c8 次要文字
const COLOR_CLOSE: u32 = 0x0030_2C4A; // #4a2c30 暗红底

/// 划词浮窗的交互状态（button 模式状态机）。
///
/// 移植自 `extension/src/content/hover-translator.ts` 的
/// `selectionMode: 'button'` 分支，只搬状态机，**不带任何 DOM 逻辑**。
///
/// ```text
/// [空闲] ──检测到选区──> [气泡] ──用户点击──> [翻译中] ──> [结果]
///            ↑                                │              │
///            └──────Esc / × / 点击外部────────┴──────────────┘
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BubbleState {
    /// 空闲：无浮窗。
    Idle,
    /// 小气泡已显示，等待用户点击。
    Bubble,
    /// 用户已点击，翻译进行中。
    Translating,
    /// 结果浮窗已显示。
    Result,
}

impl BubbleState {
    /// 是否处于「浮窗可见」的状态（决定是否需要跑轮询定时器）。
    #[allow(dead_code)]
    pub fn is_visible(self) -> bool {
        !matches!(self, BubbleState::Idle)
    }
}

/// 浮窗要显示的内容（与 Win32 无关，便于单测）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BubbleContent {
    /// 划选到的原文。
    pub source: String,
    /// 译文（`Result` 状态下必有）。
    pub translation: String,
    /// 失败原因（翻译失败时展示）。
    pub error: Option<String>,
}

/// 浮窗状态（挂在窗口 `GWLP_USERDATA` 上）。
struct BubbleWin {
    state: BubbleState,
    content: BubbleContent,
    /// 锚点（虚拟屏物理坐标）。`None` = 无坐标可用（剪贴板降级路径），
    /// 此时由 [`locate_bubble`] 回落到光标位置。
    anchor: Option<POINT>,
    /// DPI 缩放系数（1.0 = 96 DPI）。
    scale: f64,
    /// 当前窗口矩形（物理像素）。
    rect: RECT,
    /// 轮询用的按键去抖状态。
    esc_armed: bool,
    click_armed: bool,
    /// 翻译完成回调（由调用方注入，负责走 Translator + 日志）。
    ///
    /// 用回调而非直接依赖 `Translator`，是为了让本模块不关心翻译从哪来——
    /// 但**回调内部必须走 `Translator` 的降级链**（见 `main_window.rs` 的接线）。
    #[allow(clippy::type_complexity)]
    on_translate: Box<dyn Fn(&str) -> Result<String, String> + Send>,
    /// 用户主动关闭（×/Esc/点外部）时触发，用于回滚调用方状态。
    on_dismiss: Box<dyn Fn() + Send>,
    /// 消息循环退出标志。
    done: bool,
}

/// 按 DPI 把逻辑像素换算为物理像素。
///
/// 刻意**不用** Win32 的 `MulDiv`——已核实 `Win32::Graphics::Gdi` 未导出该符号。
/// 纯整数算术在此处足够（最大输入不到 1000，DPI 不超过 480）。
fn px(v: i32, scale: f64) -> i32 {
    ((v as f64) * scale).round() as i32
}

/// 计算浮窗位置。
///
/// `anchor` 为 `Some` 时贴锚点右下；`None`（剪贴板降级路径**原理上拿不到选区坐标**，
/// 不做启发式硬凑）时回落到当前光标位置。返回窗口左上角物理坐标。
///
/// 抽成独立函数是为了将来接精确选区坐标时只改这里。
fn locate_bubble(anchor: Option<POINT>, scale: f64, screen: RECT) -> POINT {
    let base = anchor.unwrap_or_else(|| {
        let mut p = POINT::default();
        // SAFETY: POINT 是纯栈结构，GetCursorPos 对它无条件写入。
        let _ = unsafe { GetCursorPos(&mut p) };
        p
    });
    let size = px(BUBBLE_SIZE, scale);
    let gap = px(BUBBLE_GAP, scale);
    // 右下偏移；贴近屏幕右下/下边缘时翻到左上，避免完全出屏。
    let mut x = base.x + gap;
    let mut y = base.y + gap;
    if x + size > screen.right {
        x = base.x - gap - size;
    }
    if y + size > screen.bottom {
        y = base.y - gap - size;
    }
    POINT { x, y }
}

/// 展示划词浮窗，阻塞直到用户关闭。
///
/// # 参数
/// - `anchor`：划词起点物理坐标。`None` 表示取词路径拿不到坐标（剪贴板降级），
///   内部回落到光标位置。
/// - `content`：原文（翻译在点击后由 `on_translate` 产出）。
/// - `on_translate`：点击气泡后调用，返回译文或错误串。**实现方必须走 `Translator` 降级链。**
/// - `on_dismiss`：用户主动关闭时调用一次。
///
/// # 线程约束
///
/// Win32 窗口归属于创建它的线程，故本函数**必须**在 worker 线程上调用
/// （内部要创建窗口并跑自己的消息循环）。**绝不能**放在全局热键的消息泵线程上——
/// 那里阻塞会令所有热键与窗口消息停摆（`main_window.rs` 里已有同样的教训记录）。
#[allow(clippy::type_complexity)]
pub fn show_bubble(
    anchor: Option<POINT>,
    content: BubbleContent,
    #[allow(clippy::type_complexity)]
    on_translate: Box<dyn Fn(&str) -> Result<String, String> + Send>,
    on_dismiss: Box<dyn Fn() + Send>,
) {
    unsafe {
        // 与 region_picker 同源：必须最先做，否则 GetCursorPos 与窗口坐标系不一致。
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

        let screen = virtual_screen();
        let scale = detect_scale();
        let mut state = BubbleWin {
            state: BubbleState::Bubble,
            content,
            anchor,
            scale,
            rect: RECT::default(),
            esc_armed: false,
            click_armed: false,
            on_translate,
            on_dismiss,
            done: false,
        };

        let class_name: Vec<u16> = "FSWordBubble\0".encode_utf16().collect();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH::default(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            style: CS_HREDRAW | CS_VREDRAW,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            // 类已存在（重复调用）不算致命，与 region_picker 同策略。
        }

        let size = px(BUBBLE_SIZE, scale);
        let pos = locate_bubble(state.anchor, scale, screen);
        state.rect = RECT {
            left: pos.x,
            top: pos.y,
            right: pos.x + size,
            bottom: pos.y + size,
        };

        let hwnd = CreateWindowExW(
            // 不抢焦点三件套之1：窗口本身不进入激活循环。
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            PCWSTR(class_name.as_ptr()),
            PCWSTR(ptr::null()),
            WS_POPUP,
            state.rect.left,
            state.rect.top,
            size,
            size,
            None,
            None,
            None,
            None,
        )
        .ok();

        let Some(hwnd) = hwnd else {
            crate::log::line("bubble: 创建浮窗失败（CreateWindowExW 返回空）");
            (state.on_dismiss)();
            let _ = UnregisterClassW(PCWSTR(class_name.as_ptr()), None);
            return;
        };

        // lpParam 传 None，状态统一由 GWLP_USERDATA 携带（CreateWindowExW 需 Option 参数，
        // 传指针反而要处理 WM_NCCREATE 时序，直接用 SetWindowLongPtr 更省事）。
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, &mut state as *mut BubbleWin as isize);

        // 不抢焦点三件套之2：显示时用 SW_SHOWNOACTIVATE，**不能**用 SW_SHOW。
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        // 状态刚变，需要重绘一次
        let _ = SetTimer(hwnd, TIMER_ID, POLL_MS, None);

        log::line(&format!(
            "bubble: 显示小气泡 state={:?} scale={:.2} anchor={:?} source={} chars",
            state.state,
            state.scale,
            state.anchor,
            state.content.source.chars().count()
        ));

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if state.done {
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        let _ = KillTimer(hwnd, TIMER_ID);
        let _ = DestroyWindow(hwnd);
        let _ = UnregisterClassW(PCWSTR(class_name.as_ptr()), None);
        log::line("bubble: 浮窗已关闭");
    }
}

/// 虚拟屏矩形（与 `region_picker` 同源，保证多屏/负坐标正确）。
unsafe fn virtual_screen() -> RECT {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    RECT {
        left: GetSystemMetrics(SM_XVIRTUALSCREEN),
        top: GetSystemMetrics(SM_YVIRTUALSCREEN),
        right: GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN),
        bottom: GetSystemMetrics(SM_YVIRTUALSCREEN) + GetSystemMetrics(SM_CYVIRTUALSCREEN),
    }
}

/// DPI 缩放系数。取不到时按 1.0 兜底（96 DPI）。
unsafe fn detect_scale() -> f64 {
    match GetDpiForWindow(HWND::default()) {
        0 => 1.0,
        dpi => dpi as f64 / 96.0,
    }
}

/// 状态机：空闲 → 气泡（检测到选区）。
///
/// 抽成独立函数便于单测（`cargo clippy` 不检查 `#[cfg(test)]`，改本模块必须同时跑 test）。
#[allow(dead_code)]
fn enter_bubble(state: &mut BubbleWin) {
    state.state = BubbleState::Bubble;
}

/// 状态机：气泡 → 翻译中 → 结果。
///
/// 翻译在此**同步**执行：浮窗跑在自己的消息循环里，同步阻塞期间不会有重入，
/// 也天然保证「一次点击只翻译一次」——移植自 `hover-translator.ts` 的
/// `dataset.busy` 幂等保护（那里同样警告：任何依赖 click 的方案都会被
/// 「按钮中途被移除」击穿，故用 mousedown 而非 click）。
unsafe fn start_translate(hwnd: HWND, state: &mut BubbleWin) {
    if state.state != BubbleState::Bubble {
        return; // 幂等：已在翻译或已出结果，忽略重复点击
    }
    state.state = BubbleState::Translating;
    state.rect = RECT::default();
    // 翻译期间不再重定位、不再响应点击（状态机已拦住 WM_LBUTTONDOWN）。
    let _ = SetWindowPos(
        hwnd,
        HWND::default(),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    );
    let _ = ShowWindow(hwnd, SW_HIDE);
    log::line("bubble: 用户点击气泡，开始翻译");

    let src = state.content.source.clone();
    match (state.on_translate)(&src) {
        Ok(t) => {
            log::line(&format!(
                "bubble: 翻译成功 src={} trans={}",
                src.chars().count(),
                t.chars().count()
            ));
            state.content.translation = t;
            state.content.error = None;
            // 翻译在后台完成后，浮窗可能已被用户关掉（done）—— 此时不再弹结果。
            if !state.done {
                state.state = BubbleState::Result;
                show_result(hwnd, state);
            }
        }
        Err(e) => {
            log::line(&format!("bubble: 翻译失败 {e}"));
            state.content.error = Some(e);
            if !state.done {
                state.state = BubbleState::Result;
                show_result(hwnd, state);
            }
        }
    }
}

/// 展开成结果窗：改窗口尺寸 + 重新显示。
unsafe fn show_result(hwnd: HWND, state: &mut BubbleWin) {
    let (w, h) = result_size(state);
    let pos = locate_bubble(state.anchor, state.scale, virtual_screen());
    // 结果窗比气泡宽，改为以锚点为**左上角**展开，避免盖住刚划选的原文。
    let rect = RECT {
        left: pos.x,
        top: pos.y,
        right: pos.x + w,
        bottom: pos.y + h,
    };
    state.rect = rect;
    let _ = SetWindowPos(
        hwnd,
        HWND::default(),
        rect.left,
        rect.top,
        w,
        h,
        SWP_NOACTIVATE | SWP_SHOWWINDOW,
    );
    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    log::line(&format!("bubble: 结果窗已显示 {w}x{h}"));
}

/// 结果窗尺寸：按文本长度估算，纯视觉参数，真机可调。
fn result_size(state: &BubbleWin) -> (i32, i32) {
    let max_w = px(RESULT_MAX_W, state.scale);
    let src_lines = estimate_lines(&state.content.source, max_w - 2 * px(RESULT_PAD, state.scale));
    let body = if let Some(err) = &state.content.error {
        estimate_lines(err, max_w - 2 * px(RESULT_PAD, state.scale))
    } else {
        estimate_lines(&state.content.translation, max_w - 2 * px(RESULT_PAD, state.scale))
    };
    let mut h = px(RESULT_PAD, state.scale) * 2
        + src_lines * px(20, state.scale)
        + body * px(20, state.scale)
        + px(CLOSE_BTN, state.scale) + px(8, state.scale);
    let max_h = px(RESULT_MAX_H, state.scale);
    if h > max_h {
        h = max_h;
    }
    (max_w, h)
}

/// 估算文本在给定宽度下占几行（中文按 2 倍宽度估算，纯视觉启发式）。
fn estimate_lines(text: &str, avail_w: i32) -> i32 {
    if text.is_empty() || avail_w <= 0 {
        return 1;
    }
    // 以 8 逻辑像素为一个「半角字符宽」，中文记 2。
    let unit = 8i32;
    let mut lines = 1;
    let mut acc = 0i32;
    for c in text.chars() {
        let w = if (c as u32) > 0x2E80 { unit * 2 } else { unit };
        if acc + w > avail_w {
            lines += 1;
            acc = 0;
        }
        acc += w;
    }
    lines.clamp(1, 200)
}

/// 关闭浮窗：标记完成 + 通知调用方。
unsafe fn dismiss(hwnd: HWND, state: &mut BubbleWin) {
    if state.state == BubbleState::Idle {
        return; // 幂等
    }
    log::line(&format!(
        "bubble: 用户关闭浮窗（state={:?}）",
        state.state
    ));
    state.state = BubbleState::Idle;
    state.done = true;
    (state.on_dismiss)();
    let _ = DestroyWindow(hwnd);
    PostQuitMessage(0);
}

/// 轮询：Esc（去抖）或「在浮窗外按下左键」→ 关闭。
///
/// 浮窗不抢焦点，故收不到 `WM_KEYDOWN`；也**收不到**外部窗口的点击消息，
/// 只能靠轮询 `GetAsyncKeyState` 感知「用户点了别处」。
unsafe fn poll_input(hwnd: HWND, state: &mut BubbleWin) {
    // Esc 去抖：armed 期间视为「已按下」，抬起后重新武装。
    let esc_down = GetAsyncKeyState(VK_ESCAPE.0 as i32) < 0;
    if esc_down {
        if state.esc_armed {
            return; // 已处理过这一次按下，等抬起
        }
        state.esc_armed = true;
        dismiss(hwnd, state);
        return;
    }
    state.esc_armed = false;

    // 鼠标左键：按下瞬间判定一次（去抖），若落点在浮窗外则关闭。
    let lbtn_down = GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0;
    if lbtn_down {
        if state.click_armed {
            return;
        }
        state.click_armed = true;
        let mut p = POINT::default();
        let _ = GetCursorPos(&mut p);
        let inside = p.x >= state.rect.left
            && p.x < state.rect.right
            && p.y >= state.rect.top
            && p.y < state.rect.bottom;
        if !inside {
            log::line("bubble: 检测到浮窗外点击，关闭");
            dismiss(hwnd, state);
        }
    } else {
        state.click_armed = false;
    }
}

/// WM_PAINT：按当前状态绘制。先画进内存 DC 再一次贴出，避免闪烁。
unsafe fn paint(hwnd: HWND, state: &BubbleWin) {
    let mut ps = windows::Win32::Graphics::Gdi::PAINTSTRUCT::default();
    let hdc = BeginPaint(hwnd, &mut ps);
    if hdc.0.is_null() {
        return;
    }
    let rect = ps.rcPaint;
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    if w <= 0 || h <= 0 {
        let _ = EndPaint(hwnd, &ps);
        return;
    }

    let mem = CreateCompatibleDC(hdc);
    let canvas = CreateCompatibleBitmap(hdc, w, h);
    let old = SelectObject(mem, canvas);

    match state.state {
        BubbleState::Result => {
            let bg = CreateSolidBrush(COLORREF(COLOR_PANEL));
            let _ = FillRect(
                mem,
                &RECT {
                    left: 0,
                    top: 0,
                    right: w,
                    bottom: h,
                },
                bg,
            );
            let _ = DeleteObject(bg);
            draw_result(mem, state, w, h);
        }
        // 气泡 / 翻译中 / 空闲都画成小圆角方块（翻译中用灰色提示不可点）。
        _ => {
            let color = if state.state == BubbleState::Translating {
                COLOR_PANEL
            } else {
                COLOR_ACCENT
            };
            let brush = CreateSolidBrush(COLORREF(color));
            // 圆角矩形（右/下参数是圆角椭圆宽高）
            let _ = windows::Win32::Graphics::Gdi::RoundRect(
                mem,
                0,
                0,
                w,
                h,
                px(8, state.scale),
                px(8, state.scale),
            );
            // RoundRect 用的是当前 brush/pen，需重新选中
            let _ = SelectObject(mem, brush);
            let _ = windows::Win32::Graphics::Gdi::RoundRect(
                mem,
                0,
                0,
                w,
                h,
                px(8, state.scale),
                px(8, state.scale),
            );
            let _ = DeleteObject(brush);

            let mut text: Vec<u16> = "译".encode_utf16().collect();
            text.push(0);
            let font = CreateFontW(
                px(15, state.scale),
                0,
                0,
                0,
                FW_NORMAL.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET.0 as u32,
                OUT_DEFAULT_PRECIS.0 as u32,
                0,
                0,
                FF_DONTCARE.0 as u32,
                PCWSTR::null(),
            );
            let oldfont = SelectObject(mem, font);
            let _ = SetBkMode(mem, TRANSPARENT);
            let _ = SetTextColor(mem, COLORREF(COLOR_TEXT));
            let mut r = RECT {
                left: 0,
                top: 0,
                right: w,
                bottom: h,
            };
            let _ = DrawTextW(
                mem,
                &mut text,
                &mut r,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE,
            );
            let _ = SelectObject(mem, oldfont);
            let _ = DeleteObject(font);
        }
    }

    let _ = BitBlt(hdc, rect.left, rect.top, w, h, mem, 0, 0, SRCCOPY);
    let _ = SelectObject(mem, old);
    let _ = DeleteObject(canvas);
    let _ = DeleteDC(mem);
    let _ = EndPaint(hwnd, &ps);
}

/// 绘制结果窗：原文（次要色）+ 译文（主色）+ 右上角关闭按钮。
///
/// B1 阶段**只画 `[×]` 与纯文本**：设计 §3.2 的[朗读][收藏★][详解]属 B3/C/D，
/// 此处刻意不画空按钮——§3.3 明确「给用户一个死按钮」是竞品差评的成因。
unsafe fn draw_result(hdc: windows::Win32::Graphics::Gdi::HDC, state: &BubbleWin, w: i32, h: i32) {
    let scale = state.scale;
    let pad = px(RESULT_PAD, scale);
    let btn = px(CLOSE_BTN, scale);
    let font = CreateFontW(
        px(14, scale),
        0,
        0,
        0,
        FW_NORMAL.0 as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        0,
        0,
        FF_DONTCARE.0 as u32,
        PCWSTR::null(),
    );
    let oldfont = SelectObject(hdc, font);
    let _ = SetBkMode(hdc, TRANSPARENT);

    let mut y = pad;

    // 原文（次要色）
    let _ = SetTextColor(hdc, COLORREF(COLOR_DIM));
    y += draw_block(
        hdc,
        &state.content.source,
        RECT {
            left: pad,
            top: y,
            right: w - pad,
            bottom: y + px(20, scale) * 6,
        },
        scale,
    );

    y += px(8, scale);

    // 译文或错误（主色 / 警示色）
    let (body, color) = match &state.content.error {
        Some(e) => (e.clone(), COLOR_CLOSE),
        None => (state.content.translation.clone(), COLOR_TEXT),
    };
    let _ = SetTextColor(hdc, COLORREF(color));
    let _ = draw_block(
        hdc,
        &body,
        RECT {
            left: pad,
            top: y,
            right: w - pad,
            bottom: h - pad - btn,
        },
        scale,
    );

    // 关闭按钮（右上角）
    let close_brush = CreateSolidBrush(COLORREF(COLOR_CLOSE));
    let _ = SelectObject(hdc, close_brush);
    let _ = windows::Win32::Graphics::Gdi::RoundRect(
        hdc,
        w - pad - btn,
        pad,
        w - pad,
        pad + btn,
        px(6, scale),
        px(6, scale),
    );
    let mut x: Vec<u16> = "×".encode_utf16().collect();
    x.push(0);
    let _ = SetTextColor(hdc, COLORREF(COLOR_TEXT));
    let mut r = RECT {
        left: w - pad - btn,
        top: pad,
        right: w - pad,
        bottom: pad + btn,
    };
    let _ = DrawTextW(hdc, &mut x, &mut r, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    let _ = DeleteObject(close_brush);

    let _ = SelectObject(hdc, oldfont);
    let _ = DeleteObject(font);
}

/// 绘制一段文本，返回实际占用高度（逻辑像素换算后的物理高度）。
unsafe fn draw_block(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    text: &str,
    r: RECT,
    scale: f64,
) -> i32 {
    if text.is_empty() {
        return 0;
    }
    let mut buf: Vec<u16> = text.encode_utf16().collect();
    buf.push(0);
    let mut rect = r;
    // DT_WORDBREAK 需要多行文本；返回实际绘制的矩形高度
    let _ = DrawTextW(
        hdc,
        &mut buf,
        &mut rect,
        DT_WORDBREAK | DT_LEFT | windows::Win32::Graphics::Gdi::DT_EDITCONTROL,
    );
    (rect.bottom - rect.top).max(px(20, scale))
}

unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let raw = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    if raw == 0 {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    let state = &mut *(raw as *mut BubbleWin);

    match msg {
        WM_MOUSEACTIVATE => {
            // 不抢焦点三件套之3：鼠标点击也不激活本窗口。
            // 缺这一条，用户点气泡时目标应用会失焦（见模块文档的因果说明）。
            LRESULT(MA_NOACTIVATE as isize)
        }
        WM_ERASEBKGND => LRESULT(1), // 全在内存 DC 画，禁背景擦除防闪烁
        WM_PAINT => {
            paint(hwnd, state);
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            // 用 LBUTTONDOWN 而非 LBUTTONUP：移植 hover-translator.ts 的 mousedown 方案。
            // 那里注释明确警告过——任何依赖 click/up 的方案都会被「按钮中途被移除」击穿，
            // 表现为「点了没反应」。button 模式下气泡点击后立即消失，等 UP 必然收不到。
            if state.state == BubbleState::Bubble {
                start_translate(hwnd, state);
            } else if state.state == BubbleState::Result {
                // 结果窗：点 [×] 关闭，点其它区域也关闭（与气泡一致，减少一步）。
                let mut p = POINT::default();
                let _ = GetCursorPos(&mut p);
                let btn = px(CLOSE_BTN, state.scale);
                let pad = px(RESULT_PAD, state.scale);
                let on_close = p.x >= state.rect.right - pad - btn
                    && p.x < state.rect.right - pad
                    && p.y >= pad
                    && p.y < pad + btn;
                let _ = on_close;
                dismiss(hwnd, state);
            }
            LRESULT(0)
        }
        WM_TIMER => {
            poll_input(hwnd, state);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(content: BubbleContent) -> BubbleWin {
        BubbleWin {
            state: BubbleState::Bubble,
            content,
            anchor: None,
            scale: 1.0,
            rect: RECT::default(),
            esc_armed: false,
            click_armed: false,
            on_translate: Box::new(|_| Err("test".into())),
            on_dismiss: Box::new(|| {}),
            done: false,
        }
    }

    /// oracle: 状态机起点是气泡态且可见
    #[test]
    fn initial_state_is_visible_bubble() {
        let s = BubbleState::Bubble;
        assert!(s.is_visible());
        assert_ne!(s, BubbleState::Idle);
    }

    /// oracle: 只有 Idle 不可见
    #[test]
    fn only_idle_is_invisible() {
        assert!(!BubbleState::Idle.is_visible());
        assert!(BubbleState::Translating.is_visible());
        assert!(BubbleState::Result.is_visible());
    }

    /// oracle: DPI 换算：scale=1 时 1:1；scale=2 时翻倍
    #[test]
    fn px_scales_with_dpi() {
        assert_eq!(px(28, 1.0), 28);
        assert_eq!(px(28, 2.0), 56);
        assert_eq!(px(10, 1.5), 15);
    }

    /// oracle: 文本行数估算——空文本算 1 行，短文本 1 行
    #[test]
    fn estimate_lines_handles_empty_and_short() {
        assert_eq!(estimate_lines("", 200), 1);
        assert_eq!(estimate_lines("hi", 200), 1);
    }

    /// oracle: 文本行数随宽度递减
    #[test]
    fn estimate_lines_grows_as_width_shrinks() {
        let text = "这是一段用于测试的中文文本，应该会换行";
        let wide = estimate_lines(text, 400);
        let narrow = estimate_lines(text, 80);
        assert!(
            narrow > wide,
            "窄宽度行数应更多：wide={wide} narrow={narrow}"
        );
    }

    /// oracle: 结果窗高度不超过上限
    #[test]
    fn result_size_respects_max_height() {
        let mut s = win(BubbleContent {
            source: "x".repeat(5000),
            translation: "y".repeat(5000),
            error: None,
        });
        s.scale = 1.0;
        let (w, h) = result_size(&s);
        assert_eq!(w, RESULT_MAX_W);
        assert!(h <= RESULT_MAX_H, "结果窗高度应受限，实际 {h}");
    }

    /// oracle: anchor 为 None 时回落到光标，不 panic 且落在虚拟屏内
    #[test]
    fn locate_bubble_without_anchor_falls_back_to_cursor() {
        let screen = RECT {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        let p = locate_bubble(None, 1.0, screen);
        // 至少要有一部分在屏内（不要求完全在屏内，贴近边缘时允许溢出）
        assert!(p.x < screen.right && p.y < screen.bottom);
    }

    /// oracle: 有 anchor 时贴其右下，且靠近屏幕右下时翻到左上
    #[test]
    fn locate_bubble_flips_at_screen_edge() {
        let screen = RECT {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        // 靠近右下角 → 应翻到左上方（坐标小于 anchor）
        let near_corner = POINT {
            x: screen.right - 2,
            y: screen.bottom - 2,
        };
        let flipped = locate_bubble(Some(near_corner), 1.0, screen);
        assert!(
            flipped.x < near_corner.x && flipped.y < near_corner.y,
            "贴边应翻到左上：anchor={near_corner:?} got={flipped:?}"
        );

        // 靠左上的 anchor → 直接右下
        let top_left = POINT { x: 100, y: 100 };
        let normal = locate_bubble(Some(top_left), 1.0, screen);
        assert!(normal.x > top_left.x && normal.y > top_left.y);
    }

    /// oracle: 虚拟屏负坐标（左/上屏）也能正确定位
    #[test]
    fn locate_bubble_handles_negative_virtual_screen() {
        let screen = RECT {
            left: -1920,
            top: -200,
            right: 0,
            bottom: 1080,
        };
        let anchor = POINT { x: -1800, y: 100 };
        let p = locate_bubble(Some(anchor), 1.0, screen);
        assert_eq!(p.x, anchor.x + BUBBLE_GAP);
        assert_eq!(p.y, anchor.y + BUBBLE_GAP);
    }

    /// oracle: DPI 放大后仍贴 anchor（偏移量按 scale 换算）
    #[test]
    fn locate_bubble_scales_gap_with_dpi() {
        let screen = RECT {
            left: 0,
            top: 0,
            right: 3840,
            bottom: 2160,
        };
        let anchor = POINT { x: 100, y: 100 };
        let p = locate_bubble(Some(anchor), 2.0, screen);
        assert_eq!(p.x, 100 + BUBBLE_GAP * 2);
        assert_eq!(p.y, 100 + BUBBLE_GAP * 2);
    }

    /// oracle: enter_bubble 把状态置为 Bubble
    #[test]
    fn enter_bubble_sets_state() {
        let mut s = win(BubbleContent::default());
        s.state = BubbleState::Idle;
        enter_bubble(&mut s);
        assert_eq!(s.state, BubbleState::Bubble);
    }
}
