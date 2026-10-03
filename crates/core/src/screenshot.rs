//! 屏幕截图（M6）。Windows 平台实现：GDI `BitBlt` + `GetDIBits`。
//!
//! Windows GDI 原生产生 **BGRA** 像素，本模块据此把 `RawImage.format` 设为
//! [`PixelFormat::Bgra`]，后续 OCR 阶段（`to_rgb_image`）会按此纠正通道顺序，
//! 避免红蓝互换。
//!
//! 多显示器：`EnumDisplayMonitors` 枚举所有显示器；`capture_target` 支持
//! 主显示器 / 指定区域 / 指定显示器 / 全部显示器合并（虚拟屏）/ 光标所在显示器。
//!
//! 注意：截图依赖交互式桌面（Window Station / Desktop）。在无桌面的服务会话中
//! `GetDC(NULL)` 可能返回空 DC，此时函数返回 [`AppError::Capture`]。

use crate::error::{AppError, Result};
use crate::types::{CaptureTarget, PixelFormat, RawImage};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors,
    GetDC, GetDIBits, GetMonitorInfoW, HDC, HMONITOR, MonitorFromPoint, MONITORINFO,
    MONITOR_DEFAULTTONEAREST, ReleaseDC, SelectObject, BI_RGB, BITMAPINFO, BITMAPINFOHEADER,
    DIB_RGB_COLORS, RGBQUAD, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// 单个显示器的几何信息（虚拟屏坐标）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorInfo {
    /// 索引（0-based，按枚举顺序）
    pub index: usize,
    /// 左边界（虚拟屏坐标，可为负）
    pub left: i32,
    /// 上边界（虚拟屏坐标，可为负）
    pub top: i32,
    /// 宽度（像素）
    pub width: i32,
    /// 高度（像素）
    pub height: i32,
}

/// 把值夹到 [lo, hi] 闭区间。
fn clamp(v: i32, lo: i32, hi: i32) -> i32 {
    v.max(lo).min(hi)
}

/// `EnumDisplayMonitors` 回调：把每个显示器矩形追加到 `lparam` 指向的 `Vec<MonitorInfo>`。
extern "system" fn monitor_enum_proc(
    _hmonitor: HMONITOR,
    _hdc: HDC,
    lprect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    unsafe {
        if lprect.is_null() {
            return TRUE;
        }
        let r = *lprect;
        // lparam 携带调用方栈上的 Vec 指针；回调期间其生命周期有效
        let list = &mut *(lparam.0 as *mut Vec<MonitorInfo>);
        let index = list.len();
        list.push(MonitorInfo {
            index,
            left: r.left,
            top: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
        });
        TRUE
    }
}

/// 枚举当前所有显示器（虚拟屏坐标）。
///
/// 无桌面会话下可能返回空列表但不报错；调用方据此判断。
pub fn list_monitors() -> Vec<MonitorInfo> {
    let mut monitors: Vec<MonitorInfo> = Vec::new();
    unsafe {
        let data = LPARAM(&mut monitors as *mut Vec<MonitorInfo> as isize);
        let _ = EnumDisplayMonitors(HDC::default(), None, Some(monitor_enum_proc), data);
    }
    monitors
}

/// 核心：截取屏幕 DC 上以 `(x, y)` 为左上角、尺寸 `(w, h)` 的矩形区域。
///
/// `x, y` 为虚拟屏坐标（可负，用于左/上延伸的副显示器）。返回 BGRA 像素，
/// 首行即图像顶部（负 `biHeight` 让 `GetDIBits` 直出 top-down）。
fn capture_rect(x: i32, y: i32, w: i32, h: i32) -> Result<RawImage> {
    if w <= 0 || h <= 0 {
        return Err(AppError::Capture(format!("截图尺寸无效：{w}x{h}")));
    }

    unsafe {
        let hwnd = HWND(std::ptr::null_mut());
        let hdc_screen = GetDC(hwnd);
        if hdc_screen.is_invalid() {
            return Err(AppError::Capture("GetDC(NULL) 失败：可能处于无桌面会话".into()));
        }

        let hdc_mem = CreateCompatibleDC(hdc_screen);
        if hdc_mem.is_invalid() {
            let _ = ReleaseDC(hwnd, hdc_screen);
            return Err(AppError::Capture("CreateCompatibleDC 失败".into()));
        }

        let hbitmap = CreateCompatibleBitmap(hdc_screen, w, h);
        if hbitmap.is_invalid() {
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(hwnd, hdc_screen);
            return Err(AppError::Capture("CreateCompatibleBitmap 失败".into()));
        }

        let old_obj = SelectObject(hdc_mem, hbitmap);
        let blitted = BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, x, y, SRCCOPY);
        if blitted.is_err() {
            let _ = SelectObject(hdc_mem, old_obj);
            let _ = DeleteObject(hbitmap);
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(hwnd, hdc_screen);
            return Err(AppError::Capture("BitBlt 失败".into()));
        }

        // 32-bit BGRA，负 biHeight => top-down 输出（首行即图像顶部，无需手动翻转）
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -(h),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD::default()],
        };

        let mut data = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = GetDIBits(
            hdc_mem,
            hbitmap,
            0,
            h as u32,
            Some(data.as_mut_ptr() as *mut std::ffi::c_void),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // 无论成功与否都先释放 GDI 资源
        let _ = SelectObject(hdc_mem, old_obj);
        let _ = DeleteObject(hbitmap);
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(hwnd, hdc_screen);

        if lines == 0 {
            return Err(AppError::Capture("GetDIBits 失败：读取位图像素为空".into()));
        }

        Ok(RawImage {
            width: w as u32,
            height: h as u32,
            data,
            format: PixelFormat::Bgra,
        })
    }
}

/// 捕获主显示器；`None` = 全屏（主显示器，`SM_CXSCREEN/SM_CYSCREEN`）。
///
/// `region` 解释为 `[x, y, width, height]`（左上角 + 尺寸），并自动夹取到屏幕范围内。
pub fn capture(region: Option<[i32; 4]>) -> Result<RawImage> {
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    if screen_w <= 0 || screen_h <= 0 {
        return Err(AppError::Capture("无法获取屏幕尺寸（GetSystemMetrics 返回 0）".into()));
    }

    let (x, y, w, h) = match region {
        Some([rx, ry, rw, rh]) => (
            clamp(rx, 0, screen_w),
            clamp(ry, 0, screen_h),
            clamp(rw, 1, screen_w - clamp(rx, 0, screen_w)),
            clamp(rh, 1, screen_h - clamp(ry, 0, screen_h)),
        ),
        None => (0, 0, screen_w, screen_h),
    };

    capture_rect(x, y, w, h)
}

/// 捕获全部显示器合并的虚拟屏（跨显示器大图）。
pub fn capture_virtual() -> Result<RawImage> {
    let vx = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let vy = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let vw = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let vh = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if vw <= 0 || vh <= 0 {
        return Err(AppError::Capture("无法获取虚拟屏尺寸（多显示器可能未启用）".into()));
    }
    capture_rect(vx, vy, vw, vh)
}

/// 捕获指定索引的显示器（0-based）。
pub fn capture_monitor(index: usize) -> Result<RawImage> {
    let monitors = list_monitors();
    let m = monitors
        .into_iter()
        .find(|m| m.index == index)
        .ok_or_else(|| AppError::Capture(format!("找不到索引为 {index} 的显示器（共枚举到显示器）")))?;
    capture_rect(m.left, m.top, m.width, m.height)
}

/// 捕获**光标当前所在**的显示器（多显示器热键最直观的默认行为）。
///
/// 取 `GetCursorPos` 后用 `MonitorFromPoint` 定位显示器，再截取该显示器矩形；
/// 任一环节失败（无桌面、取不到光标）都安全回退到主显示器，绝不中断管线。
pub fn capture_active_monitor() -> Result<RawImage> {
    unsafe {
        let mut pt = windows::Win32::Foundation::POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt).is_err() {
            return capture(None);
        }
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        if hmon.is_invalid() {
            return capture(None);
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(hmon, &mut info).as_bool() {
            return capture(None);
        }
        let r = info.rcMonitor;
        capture_rect(r.left, r.top, r.right - r.left, r.bottom - r.top)
    }
}

/// 按 [`CaptureTarget`] 统一入口：主显示器 / 区域 / 指定显示器 / 全部显示器 / 光标显示器。
pub fn capture_target(target: CaptureTarget) -> Result<RawImage> {
    match target {
        CaptureTarget::Primary => capture(None),
        CaptureTarget::Region { x, y, w, h } => capture_rect(x, y, w, h),
        CaptureTarget::Monitor { index } => capture_monitor(index),
        CaptureTarget::All => capture_virtual(),
        CaptureTarget::Active => capture_active_monitor(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_data_is_empty() {
        // 单元层不依赖桌面；仅校验错误类型可用
        let err = AppError::Capture("test".into());
        assert!(err.to_string().contains("截图失败"));
    }

    #[test]
    fn list_monitors_runs_without_panic() {
        // 枚举不应 panic；无桌面会话可能为空，但必须是合法 Vec
        let monitors = list_monitors();
        assert!(monitors.len() <= 16, "显示器数量异常偏多");
        // 索引必须连续且唯一
        for (i, m) in monitors.iter().enumerate() {
            assert_eq!(m.index, i);
            assert!(m.width > 0 && m.height > 0, "显示器尺寸必须为正");
        }
    }

    /// 集成校验：在真实桌面会话下截图应得到正尺寸 BGRA 图像。
    /// 无桌面会话（CI/服务）会忽略；手动跑：`cargo test -- --ignored capture_full_screen`
    #[test]
    #[ignore = "需真实桌面会话，手动跑：cargo test -- --ignored capture_full_screen"]
    fn capture_full_screen_is_valid_bgra() {
        let img = capture(None).expect("截图失败");
        assert!(img.width > 0 && img.height > 0, "截图尺寸必须为正");
        assert_eq!(img.format, PixelFormat::Bgra, "GDI 原生应为 BGRA");
        assert!(img.has_expected_len(), "数据长度必须等于 width*height*4");
    }

    #[test]
    #[ignore = "需真实桌面会话，手动跑：cargo test -- --ignored capture_virtual_screen"]
    fn capture_virtual_screen_is_valid_bgra() {
        let img = capture_virtual().expect("虚拟屏截图失败");
        assert!(img.width > 0 && img.height > 0);
        assert!(img.has_expected_len());
    }

    #[test]
    #[ignore = "需真实桌面会话，手动跑：cargo test -- --ignored capture_active_monitor"]
    fn capture_active_monitor_is_valid_bgra() {
        // 多显示器热键路径：光标所在显示器应得到正尺寸 BGRA 图
        let img = capture_active_monitor().expect("光标显示器截图失败");
        assert!(img.width > 0 && img.height > 0);
        assert_eq!(img.format, PixelFormat::Bgra);
        assert!(img.has_expected_len());
    }
}
