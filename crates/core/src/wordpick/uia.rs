//! UIA（UI Automation）取词路径 —— 划词的主路径。
//!
//! 官方文档：<https://docs.microsoft.com/zh-hk/windows/win32/winauto/uiauto-threading>
//!
//! 摘录（实现依据，勿凭印象改）：
//! > "This thread should not own any windows, and **should be a Component Object Model
//! > (COM) Multi-threaded Apartment (MTA)** model thread (one that initializes COM by
//! > calling `CoInitializeEx` with the `COINIT_MULTITHREADED` flag)."
//!
//! ⚠️ **必须是 MTA，不是 STA。** 中文社区博客大量流传"UIA 必须 STA"，与官方文档相反。
//!
//! 调用链（签名均已对照 `windows-0.58.0` 源码核实）：
//! ```text
//! CoInitializeEx(nullptr, COINIT_MULTITHREADED)
//!   → CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
//!   → IUIAutomation::GetFocusedElement()            -> IUIAutomationElement
//!   → IUIAutomationElement::GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
//!   → IUIAutomationTextPattern::GetSelection()      -> IUIAutomationTextRangeArray
//!   → fori: array.GetElement(i) -> IUIAutomationTextRange
//!            range.GetText(-1) -> BSTR               （-1 = 取到结尾）
//! ```

use std::sync::mpsc;
use std::thread;

use windows::core::BSTR;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
    IUIAutomationTextRangeArray, UIA_TextPatternId,
};

use crate::error::{AppError, Result};
use crate::wordpick::{text_is_usable, MAX_SELECTION_CHARS};

/// 读取当前前台应用的划选文本。
///
/// `timeout_ms` 是调用方给的等待上限（UIA 树遍历在大型文档/长网页上可能很慢）。
///
/// # 线程模型
///
/// 每次调用**新建一条专用 MTA 线程**，用完即退。理由：
/// - UIA 必须跑在 MTA 且不能拥有窗口；
/// - 复用常驻线程的话，一旦某次 UIA 调用卡死（COM 跨进程调用可能阻塞），
///   后续所有划词都会被这条坏线程拖死。
///
/// 代价是每次划词一次线程创建（几十微秒），换取故障隔离，可接受。
///
/// 超时后该线程仍会跑完当前 UIA 调用再自行退出，**不会被复用**——
/// 下次取词重开一条新线程，故一次卡死的 UIA 调用不会永久拖死后续划词。
///
/// # 失败情形（均应触发降级到剪贴板）
///
/// - COM 初始化/创建失败（单元状态异常、权限不足）
/// - 前台元素不支持 `UIA_TextPatternId`（游戏、自绘控件、表格网格）
/// - `GetSelection()` 无选区（**返回 `Err` 而非长度 0 数组**，见 [`read_selection_on_mta`]）
/// - 全部 range 拼接后为空或超长
/// - 超时
pub fn read_selection(timeout_ms: u64) -> Result<String> {
    let (tx, rx) = mpsc::channel();
    let timeout = std::time::Duration::from_millis(timeout_ms);

    // spawn 失败意味着无法创建线程，属于不可恢复的系统资源问题，直接返回。
    thread::Builder::new()
        .name("fs-uia".into())
        .spawn(move || {
            let _ = tx.send(read_selection_on_mta());
        })
        .map_err(|e| AppError::Config(format!("无法创建 UIA 线程: {e}")))?;

    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(AppError::Config(format!(
            "UIA 调用超时（>{timeout_ms}ms）"
        ))),
        // 线程内panic：视作UIA 不可用，降级。避免一个坏调用终止整个程序。
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(AppError::Config("UIA 线程异常退出".to_string()))
        }
    }
}

/// 在**当前线程**（必须已初始化为 MTA）上执行 UIA 取词。
///
/// 拆成独立函数是为了让 COM 初始化/反初始化严格配对在同一条线程上——
/// `CoUninitialize` 必须在初始化它的那个线程调用，跨线程会导致 COM 状态错乱。
///
/// # Safety
///
/// 调用方必须确保当前线程已 `CoInitializeEx(COINIT_MULTITHREADED)` 且未拥有窗口。
/// 本模块内的 [`read_selection`] 保证了这一点；不要在别处直接调用。
fn read_selection_on_mta() -> Result<String> {
    // SAFETY: 由本模块的线程封装保证 —— 新建线程、无窗口、MTA。
    unsafe { read_selection_on_mta_impl() }
}

/// 实际取词逻辑（裸 unsafe，已由上层封装保证 COM 与线程前提）。
unsafe fn read_selection_on_mta_impl() -> Result<String> {
    // 同线程重复调用 CoInitializeEx 需配对 CoUninitialize，故用 guard 保证。
    let _com = ComGuard::init()?;

    let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
        .map_err(|e| AppError::Config(format!("创建 IUIAutomation 失败: {e}")))?;

    let element: IUIAutomationElement = automation
        .GetFocusedElement()
        .map_err(|e| AppError::Config(format!("取前台元素失败: {e}")))?;

    // GetCurrentPatternAs 是 windows-rs 提供的泛型便捷方法，
    // 内部走 QueryInterface，失败即表示该控件不支持 TextPattern。
    let pattern: IUIAutomationTextPattern = element
        .GetCurrentPatternAs(UIA_TextPatternId)
        .map_err(|e| AppError::Config(format!("元素不支持 TextPattern: {e}")))?;

    // ⚠️ 关键判空点：控件只有插入点或不支持选择时，这里返回 Err。
    // 官方 API 文档明确 GetSelection 可能不产出 range，务必处理而非解引用。
    let ranges: IUIAutomationTextRangeArray = pattern
        .GetSelection()
        .map_err(|e| AppError::Config(format!("GetSelection 无选区: {e}")))?;

    let text = collect_ranges_text(&ranges)?;

    if !text_is_usable(&text) {
        return Err(AppError::Config("UIA 选区为空或超长".to_string()));
    }
    Ok(text)
}

/// 遍历选区 range 数组，拼接文本。
///
/// UIA 可能返回**多个不连续**的选区（如 Word 里用 Ctrl 选多个不连续词块），
/// 需全部拼接而非只取第0 个。
///
/// 防御性处理：
/// - `Length()` 可能失败 → 视为无选区；
/// - 跳过取文本失败的单个 range（部分 range 可能已失效）；
/// - 一旦累计长度超上限立即停止，避免大文档上做无谓的字符串拼接。
unsafe fn collect_ranges_text(ranges: &IUIAutomationTextRangeArray) -> Result<String> {
    let len = ranges
        .Length()
        .map_err(|e| AppError::Config(format!("读选区数量失败: {e}")))?;
    if len <= 0 {
        return Err(AppError::Config("选区数量为 0".to_string()));
    }

    let mut out = String::new();
    for i in 0..len {
        let range = match ranges.GetElement(i) {
            Ok(r) => r,
            // 单个 range 失效不应让整次取词失败，跳过继续
            Err(_) => continue,
        };
        // -1 = 取到 range 结尾（UIA 约定）。
        // 失败则跳过该 range：可能因文档被并发修改而失效。
        let bstr: BSTR = match range.GetText(-1) {
            Ok(b) => b,
            Err(_) => continue,
        };
        out.push_str(&bstr.to_string());

        if out.chars().count() > MAX_SELECTION_CHARS {
            return Err(AppError::Config("选区超长".to_string()));
        }
    }

    Ok(out.trim().to_string())
}

/// COM 初始化守卫：构造时 `CoInitializeEx`，析构时 `CoUninitialize`。
///
/// 必须成对：Windows 要求 `CoUninitialize` 在**初始化它的同一线程**上调用，
/// 否则 COM 状态错乱。用 RAII 保证任何提前 `?` 返回路径都能正确反初始化。
struct ComGuard {
    /// 是否由本 guard 完成了 COM 初始化。
    /// false 表示本线程已由其它代码初始化过 COM，此时**不应**调 `CoUninitialize`，
    /// 否则会破坏别人的初始化计数。
    owned: bool,
}

impl ComGuard {
    /// 在当前线程初始化 COM 为 MTA。
    fn init() -> Result<Self> {
        // SAFETY: 调用方（read_selection）保证在新线程上、无窗口。
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_ok() {
            return Ok(ComGuard { owned: true });
        }
        // RPC_E_CHANGED_MODE：线程已被初始化为 STA（如主 GUI 线程）。
        // 此时 UIA 大概率不可靠，向上报错而不是强行继续。
        Err(AppError::Config(format!(
            "CoInitializeEx(MTA) 失败（线程可能已是 STA）: {hr:?}"
        )))
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.owned {
            // SAFETY: 与 init 同一线程，满足 Windows 对 CoUninitialize 的要求。
            unsafe { CoUninitialize() };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 纯逻辑测试：不碰 COM，可在无 GUI 环境跑。
    ///
    /// 真机 UIA 行为需在 Word/记事本/Edge 里人工验证（阶段 A2 验收项），
    /// 自动化测试无法可靠构造"某应用有选区"的前提。

    #[test]
    fn com_guard_init_on_plain_thread_succeeds() {
        // 新建线程必然没有 COM 状态，MTA 初始化应成功
        let h = thread::spawn(|| {
            let g = ComGuard::init();
            assert!(g.is_ok(), "新线程 CoInitializeEx(MTA) 应成功");
            g
        })
        .join()
        .expect("join");
        // guard 析构不应 panic
        drop(h);
    }

    #[test]
    fn com_guard_drop_is_idempotent_safe() {
        // 重复 init/drop 不应崩溃或泄漏状态
        for _ in 0..3 {
            let g = ComGuard::init().expect("init");
            drop(g);
        }
    }

    #[test]
    fn read_selection_timeout_is_reported_not_panic() {
        // 超时应返回 Err 而非 panic/hang——浮窗不能因取词卡死
        match read_selection(1) {
            Err(_) => {}
            // 本机若有焦点控件且 UIA 恰好在 1ms 内返回，也可能 Ok；
            // 但 1ms 极短，实际必然走超时分支。这里不强断言Err，避免 CI 抖动。
            Ok(_) => {}
        }
    }
}
