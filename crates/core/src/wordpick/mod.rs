//! 划词取词内核（ADR-006）。
//!
//! 三级降级编排：
//! 1. **UIA**（[uia]）—— UI Automation `GetSelection()`，主路径。
//! 2. **剪贴板**（[clipboard]）—— 合成 Ctrl+C 后读剪贴板，UIA 读不到时的兜底。
//! 3. **截屏 OCR** —— 由调用方（GUI 层）复用 `region_picker` 框选后走既有 OCR 管线。
//!
//! 关键约束（均为实测/官方文档确认，改动前先读 `docs/划词取词设计.md`）：
//!
//! - **UIA 调用全部在专用 MTA 线程上**。微软官方 `uiauto-threading` 明确要求
//!   `CoInitializeEx(COINIT_MULTITHREADED)` 且该线程不拥有任何窗口。
//!   ⚠️ 网上中文博客普遍流传"UIA 必须 STA"，那是误传，勿照抄。
//! - **`GetSelection()` 在无选区时返回 `Err`/无效值而非长度 0 的数组**，
//!   不判空直接解引用会崩，故 [`uia::read_selection`] 内做全量判空。
//! - **剪贴板路径禁止恢复原内容**：Office 等在剪贴板放指向内部数据的指针，
//!   覆盖后"恢复"会导致指针悬空 → Office 崩溃。只读不写回（见 [clipboard]）。

use std::fmt;

use crate::error::AppError;

#[cfg(windows)]
pub mod clipboard;
#[cfg(windows)]
pub mod uia;

/// 取词成功但附带降级信息（例如原文来自剪贴板而非 UIA）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    /// 划选得到的原文（已trim）。
    pub text: String,
    /// 实际生效的取词路径。
    pub source: Source,
}

/// 取词路径。用于日志与降级诊断，不影响业务语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// UI Automation 直接读到选区（首选，无副作用）。
    Uia,
    /// 合成 Ctrl+C 读剪贴板（UIA 读不到时的兜底；**会覆盖用户剪贴板**）。
    Clipboard,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Uia => "uia",
            Source::Clipboard => "clipboard",
        }
    }
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 取词失败。`None` 与`Some(())` 的区分不重要，统一用字符串携带诊断信息。
pub type SelectionResult = std::result::Result<Selection, AppError>;

/// 选区文本的最大长度。UIA 树遍历在大型文档上可能很慢，超长文本对划词场景
/// 也没有意义（用户划的是词/句），超限直接判失败并降级，避免卡住专用线程。
pub const MAX_SELECTION_CHARS: usize = 4000;

/// UIA 调用超时（毫秒）。超时即降级到剪贴板，不让浮窗无限等待。
pub const UIA_TIMEOUT_MS: u64 = 500;

/// 统一入口：按 UIA → 剪贴板顺序尝试取词。
///
/// 两条路径都失败时返回 `Err`，调用方应降级到截屏 OCR。
///
/// 注：`fs-core` 是纯库、无日志设施（日志在 `fs-gui::log`），故本模块
/// **不写日志**，只通过返回的 `Source` /错误信息把诊断数据交给调用方。
#[cfg(windows)]
pub fn read_selection() -> SelectionResult {
    // 主路径：UIA。无副作用，不碰剪贴板。
    match uia::read_selection(UIA_TIMEOUT_MS) {
        Ok(text) => Ok(Selection { text, source: Source::Uia }),
        Err(uia_err) => {
            // 降级到剪贴板。UIA 失败原因并入最终错误信息，便于调用方诊断。
            match clipboard::read_selection_via_copy() {
                Ok(text) => Ok(Selection { text, source: Source::Clipboard }),
                Err(clip_err) => Err(AppError::Config(format!(
                    "取词失败：UIA({uia_err})、剪贴板({clip_err})；应降级到截屏 OCR"
                ))),
            }
        }
    }
}

/// 校验取到的文本是否可用（空 / 超长均视为失败，触发降级）。
///
/// 单测覆盖（`text_is_usable_*`）—— 这段判定是降级链的正确性核心，
/// 逻辑错了会让UIA 静默返回空串而不降级。
#[cfg(windows)]
pub(crate) fn text_is_usable(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty() && t.chars().count() <= MAX_SELECTION_CHARS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_usable_accepts_normal() {
        assert!(text_is_usable("hello"));
        assert!(text_is_usable("  padded  "));
        assert!(text_is_usable("多字节中文也算一个 char"));
    }

    #[test]
    fn text_is_usable_rejects_empty_and_blank() {
        // 空串与纯空白都必须降级，否则浮窗会显示空白且不降级
        assert!(!text_is_usable(""));
        assert!(!text_is_usable("   "));
        assert!(!text_is_usable("\n\t  \r\n"));
    }

    #[test]
    fn text_is_usable_rejects_overlong() {
        let long = "a".repeat(MAX_SELECTION_CHARS + 1);
        assert!(!text_is_usable(&long));
        // 边界：正好等于上限应放行
        let at_limit = "a".repeat(MAX_SELECTION_CHARS);
        assert!(text_is_usable(&at_limit));
    }

    #[test]
    fn text_is_usable_counts_chars_not_bytes() {
        // 中文 3 字节/字，若按字节判断会误杀 1333 字的中文选区
        let cn = "字".repeat(2000);
        assert_eq!(cn.len(), 6000);
        assert!(text_is_usable(&cn));
    }

    #[test]
    fn source_as_str_is_stable() {
        // 这两个字符串会进日志，被 grep 消费，不宜随意改名
        assert_eq!(Source::Uia.as_str(), "uia");
        assert_eq!(Source::Clipboard.as_str(), "clipboard");
    }
}
