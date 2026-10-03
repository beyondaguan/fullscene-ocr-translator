//! 十字形框选（纯 Win32 + GDI，2026-10-03 新建）。
//!
//! # 为什么不用 WebView2 overlay
//! 1.26 已确认「全屏 + 透明 + 无边框 + 置顶」的 **WebView2** 窗口在本机是崩溃源，
//! 且 Alt+Q / Alt+2 从未成功弹出过可用遮罩。本模块改用**纯 Win32 窗口 + GDI 自绘**：
//! 没有 WebView2、没有 React、没有前端参与，崩溃面与前者完全不同。
//!
//! # 交互（对齐 Snipaste / Win11 截图）
//! - 触发后先**冻结当前屏幕**作为背景，再在全屏窗口上框选（避免边选边变）。
//! - 光标全程为**十字**（`IDC_CROSS`）——这是「先出现截图十字」诉求的落点。
//! - 左键按下定起点 → 拖动实时显示选框 + 尺寸标签 → 松开确认。
//! - `Esc` / 右键 / 零尺寸 → 取消，返回 `None`。
//!
//! # 坐标与 DPI
//! - 窗口铺满**虚拟屏**（`SM_*VIRTUALSCREEN`），背景图同样用 `capture_virtual()`，二者同源。
//! - 全程用 `GetCursorPos`（虚拟屏坐标）而非 `lParam`（需按 DPI 换算），
//!   并在进入前强制 Per-Monitor V2 DPI 感知，规避高 DPI/多屏错位。
//! - 返回的矩形即虚拟屏坐标，可直接喂给 `fs_core::screenshot::capture_rect`。

use std::ptr;

use fs_core::error::Result;
use fs_core::types::RawImage;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleDC, CreatePen, CreateSolidBrush, DeleteDC, DeleteObject,
    DrawTextW, EndPaint, FillRect, FrameRect, GetDC, InvalidateRect, ReleaseDC, SelectObject,
    SetBkMode, SetTextColor, HBRUSH, HDC, PAINTSTRUCT, SRCCOPY,
};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, VK_ESCAPE};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    GetSystemMetrics, GetWindowLongPtrW, LoadCursorW, PostQuitMessage, RegisterClassW,
    SetCursor, SetForegroundWindow, SetWindowLongPtrW, ShowWindow, TranslateMessage,
    UnregisterClassW, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, IDC_CROSS, MSG, SM_CXVIRTUALSCREEN,
    GetCursorPos,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_SHOW, WM_DESTROY, WM_ERASEBKGND,
    WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT, WM_RBUTTONUP, WM_SETCURSOR,
    WNDCLASSW, WS_EX_TOPMOST, WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
};

/// 框选结果（虚拟屏坐标、物理像素）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PickedRegion {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 框选过程状态（挂在窗口 `GWLP_USERDATA` 上）。
struct PickState {
    /// 冻结的屏幕快照（位图 + 尺寸）
    bg: Option<Background>,
    /// 起点（左键按下时确定）
    anchor: Option<POINT>,
    /// 当前光标位置（拖动中实时更新）
    cur: POINT,
    dragging: bool,
    /// 最终结果：Some = 确认，None = 取消
    result: Option<PickedRegion>,
    done: bool,
}

struct Background {
    bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
    w: i32,
    h: i32,
}

/// 弹出十字框选遮罩，阻塞直到用户确认或取消。
///
/// 必须在**调用方线程**上创建窗口并跑消息循环（Win32 窗口归属于创建它的线程），
/// 因此本函数是阻塞的——调用方应放在 worker 线程里，不要放在 UI/热键泵线程上。
pub fn pick_region() -> Result<Option<PickedRegion>> {
    unsafe {
        // 必须最先做：DPI 不感知时 GetCursorPos 返回的是系统缩放后的虚拟坐标，
        // 而窗口按物理像素创建，两者会错位（高 DPI / 多显示器必现）。
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if vw <= 0 || vh <= 0 {
            return Ok(None);
        }

        let bg = freeze_screen()?;

        let mut state = PickState {
            bg,
            anchor: None,
            cur: POINT { x: vx + vw / 2, y: vy + vh / 2 },
            dragging: false,
            result: None,
            done: false,
        };

        let class_name: Vec<u16> = "FSRegionPicker\0".encode_utf16().collect();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hCursor: LoadCursorW(None, IDC_CROSS).unwrap_or_default(),
            hbrBackground: HBRUSH::default(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            style: CS_HREDRAW | CS_VREDRAW,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            // 类已存在（重复调用）不算致命，继续创建窗口
        }

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            PCWSTR(class_name.as_ptr()),
            PCWSTR(ptr::null()),
            WS_POPUP | WS_VISIBLE,
            vx,
            vy,
            vw,
            vh,
            None,
            None,
            None,
            Some(&mut state as *mut PickState as *const _),
        )
        .map_err(|e| fs_core::error::AppError::Capture(format!("创建框选窗口失败: {e}")))?;

        // lpParam 在 WM_NCCREATE 期间才可用；这里直接补一次，确保后续消息都能拿到状态。
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, &mut state as *mut PickState as isize);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if state.done {
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        if let Some(b) = &state.bg {
            let _ = DeleteObject(b.bitmap);
        }
        let _ = UnregisterClassW(PCWSTR(class_name.as_ptr()), None);
        Ok(state.result)
    }
}

/// 抓一帧全屏作为冻结背景（与窗口矩形同源，都是虚拟屏）。
fn freeze_screen() -> Result<Option<Background>> {
    let img = match fs_core::screenshot::capture_virtual() {
        Ok(i) => i,
        Err(_) => return Ok(None), // 抓不到屏就退化成纯色背景，不阻断框选
    };
    Ok(Some(build_bitmap(&img)?))
}

/// 把 BGRA `RawImage` 变成 DDB 位图，供 WM_PAINT 直接 BitBlt。
fn build_bitmap(img: &RawImage) -> Result<Background> {
    unsafe {
        let hdc = GetDC(None);
        let header = windows::Win32::Graphics::Gdi::BITMAPINFOHEADER {
            biSize: std::mem::size_of::<windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32,
            biWidth: img.width as i32,
            biHeight: -(img.height as i32), // 负值 = top-down，与 capture_rect 输出一致
            biPlanes: 1,
            biBitCount: 32,
            biCompression: windows::Win32::Graphics::Gdi::BI_RGB.0,
            ..Default::default()
        };
        let info = windows::Win32::Graphics::Gdi::BITMAPINFO {
            bmiHeader: header,
            bmiColors: [windows::Win32::Graphics::Gdi::RGBQUAD::default()],
        };
        let bitmap = windows::Win32::Graphics::Gdi::CreateDIBitmap(
            hdc,
            Some(&header as *const _),
            windows::Win32::Graphics::Gdi::CBM_INIT as u32,
            Some(img.data.as_ptr() as *const _),
            Some(&info as *const _),
            windows::Win32::Graphics::Gdi::DIB_RGB_COLORS,
        );
        let _ = ReleaseDC(None, hdc);
        if bitmap.0.is_null() {
            return Err(fs_core::error::AppError::Capture("创建背景位图失败".into()));
        }
        Ok(Background {
            bitmap,
            w: img.width as i32,
            h: img.height as i32,
        })
    }
}

/// 把 (起点, 当前点) 归一化成矩形。
fn normalize(a: POINT, b: POINT) -> RECT {
    RECT {
        left: a.x.min(b.x),
        top: a.y.min(b.y),
        right: a.x.max(b.x),
        bottom: a.y.max(b.y),
    }
}

/// WM_PAINT：背景 → 选框 → 尺寸标签。全部先画进内存 DC 再一次贴出（避免闪烁）。
unsafe fn paint(hwnd: HWND, state: &PickState) {
    let mut ps = PAINTSTRUCT::default();
    let hdc = BeginPaint(hwnd, &mut ps);
    if hdc.0.is_null() {
        return;
    }

    let rect = ps.rcPaint;
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    let mem = CreateCompatibleDC(hdc);
    let canvas = windows::Win32::Graphics::Gdi::CreateCompatibleBitmap(hdc, w, h);
    let old = SelectObject(mem, canvas);

    if let Some(bg) = &state.bg {
        let bgdc = CreateCompatibleDC(mem);
        let oldbg = SelectObject(bgdc, bg.bitmap);
        // 用背景自身尺寸贴：窗口铺满虚拟屏、背景是同一矩形，二者一致；
        // 万一不一致也不拉伸（BitBlt 不缩放），避免画面被拉变形。
        let _ = BitBlt(mem, 0, 0, bg.w, bg.h, bgdc, 0, 0, SRCCOPY);
        let _ = SelectObject(bgdc, oldbg);
        let _ = DeleteDC(bgdc);
    } else {
        // 抓屏失败时的兜底：深灰背景，仍能框选
        let fb = CreateSolidBrush(windows::Win32::Foundation::COLORREF(0x0030_3030));
        let _ = FillRect(mem, &RECT { left: 0, top: 0, right: w, bottom: h }, fb);
        let _ = DeleteObject(fb);
    }

    if state.dragging {
        if let Some(a) = state.anchor {
            let r = normalize(a, state.cur);
            let rw = r.right - r.left;
            let rh = r.bottom - r.top;
            if rw > 0 && rh > 0 {
                // 选区内部保持原样（不暗化），只画边框 + 四角手柄 + 尺寸标签，
                // 这样用户能直接看清自己选中的原始画面（Snipaste/WIN11 同款行为）。
                let pen = CreatePen(windows::Win32::Graphics::Gdi::PS_SOLID, 2, windows::Win32::Foundation::COLORREF(0x00FF_7A18));
                let oldpen = SelectObject(mem, pen);
                let brush = CreateSolidBrush(windows::Win32::Foundation::COLORREF(0x00FF_7A18));
                let oldbrush = SelectObject(mem, brush);
                let _ = FrameRect(mem, &r, HBRUSH(brush.0));
                for (cx, cy) in [(r.left, r.top), (r.right, r.top), (r.left, r.bottom), (r.right, r.bottom)] {
                    let hb = RECT { left: cx - 3, top: cy - 3, right: cx + 3, bottom: cy + 3 };
                    let _ = FillRect(mem, &hb, brush);
                }
                let _ = SelectObject(mem, oldpen);
                let _ = SelectObject(mem, oldbrush);
                let _ = DeleteObject(pen);
                let _ = DeleteObject(brush);

                draw_size_label(mem, &r, rw, rh);
            }
        }
    }

    let _ = BitBlt(hdc, rect.left, rect.top, w, h, mem, 0, 0, SRCCOPY);
    let _ = SelectObject(mem, old);
    let _ = DeleteObject(canvas);
    let _ = DeleteDC(mem);
    let _ = EndPaint(hwnd, &ps);
}

/// 在选框左上角外侧画「宽 × 高」标签；顶部空间不足时改画在框内。
unsafe fn draw_size_label(hdc: HDC, r: &RECT, w: i32, h: i32) {
    let mut text = format!("{w} × {h}").encode_utf16().collect::<Vec<u16>>();
    text.push(0);
    let label_h = 22;
    let above = r.top - label_h;
    let box_top = if above >= 0 { above } else { r.top + 2 };
    let lr = RECT {
        left: r.left,
        top: box_top,
        right: r.left + 110,
        bottom: box_top + label_h,
    };
    let bg = CreateSolidBrush(windows::Win32::Foundation::COLORREF(0x0020_2020));
    let _ = FillRect(hdc, &lr, bg);
    let _ = DeleteObject(bg);
    let _ = SetBkMode(hdc, windows::Win32::Graphics::Gdi::TRANSPARENT);
    let _ = SetTextColor(hdc, windows::Win32::Foundation::COLORREF(0x00FF_FFFF));
    let mut lr2 = lr;
    lr2.left += 6;
    let _ = DrawTextW(hdc, &mut text, &mut lr2, windows::Win32::Graphics::Gdi::DT_SINGLELINE | windows::Win32::Graphics::Gdi::DT_VCENTER);
}

/// 结束框选：写入结果、关窗口、退出消息循环。
unsafe fn finish(hwnd: HWND, state: &mut PickState, result: Option<PickedRegion>) {
    let _ = ReleaseCapture();
    state.result = result;
    state.done = true;
    let _ = DestroyWindow(hwnd);
    PostQuitMessage(0);
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let raw = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    if raw == 0 {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    let state = &mut *(raw as *mut PickState);

    match msg {
        WM_SETCURSOR => {
            // 全程十字光标——「按 Alt+Q 先出现截图十字」的核心观感
            if let Ok(c) = LoadCursorW(None, IDC_CROSS) {
                SetCursor(c);
            }
            LRESULT(1)
        }
        WM_ERASEBKGND => LRESULT(1), // 全部在内存 DC 里画，禁止背景擦除以免闪烁
        WM_PAINT => {
            paint(hwnd, state);
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            let mut p = POINT::default();
            let _ = GetCursorPos(&mut p);
            state.anchor = Some(p);
            state.cur = p;
            state.dragging = true;
            SetCapture(hwnd);
            let _ = InvalidateRect(hwnd, None, windows::Win32::Foundation::BOOL(0));
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            if state.dragging {
                let mut p = POINT::default();
                let _ = GetCursorPos(&mut p);
                state.cur = p;
                let _ = InvalidateRect(hwnd, None, windows::Win32::Foundation::BOOL(0));
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            if !state.dragging {
                return LRESULT(0);
            }
            let mut p = POINT::default();
            let _ = GetCursorPos(&mut p);
            state.cur = p;
            state.dragging = false;
            let r = match state.anchor {
                Some(a) => normalize(a, p),
                None => {
                    finish(hwnd, state, None);
                    return LRESULT(0);
                }
            };
            let rw = r.right - r.left;
            let rh = r.bottom - r.top;
            // 零尺寸（误点一下）视为取消，避免拿一个空矩形去 OCR
            let picked = if rw >= 4 && rh >= 4 {
                Some(PickedRegion { x: r.left, y: r.top, w: rw, h: rh })
            } else {
                None
            };
            finish(hwnd, state, picked);
            LRESULT(0)
        }
        WM_RBUTTONUP => {
            finish(hwnd, state, None);
            LRESULT(0)
        }
        WM_KEYDOWN => {
            if wparam.0 as u16 == VK_ESCAPE.0 {
                finish(hwnd, state, None);
            }
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

    #[test]
    fn normalize_orders_points_any_direction() {
        let a = POINT { x: 100, y: 200 };
        let b = POINT { x: 20, y: 30 };
        let r = normalize(a, b);
        assert_eq!((r.left, r.top, r.right, r.bottom), (20, 30, 100, 200));
        let r2 = normalize(b, a);
        assert_eq!((r2.left, r2.top, r2.right, r2.bottom), (20, 30, 100, 200));
    }

    #[test]
    fn normalize_degenerate_rect_has_zero_size() {
        let p = POINT { x: 5, y: 5 };
        let r = normalize(p, p);
        assert_eq!(r.right - r.left, 0);
        assert_eq!(r.bottom - r.top, 0);
    }
}
