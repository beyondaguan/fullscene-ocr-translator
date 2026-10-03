//! 平台无关领域类型（ADR-001 脚手架阶段）。
//!
//! 这些类型当前是从 `fs-core::types` 迁出的**占位副本**：
//! M1 将删除 `fs-core` 中的同名定义，改由 `core` 依赖 `fs-platform` 复用此处类型，
//! 从而把 `fs-platform` 确立为共享底部层、杜绝 crate 循环依赖。

use serde::{Deserialize, Serialize};

/// 像素内存布局。GDI 原生产出 BGRA，OCR 阶段按需纠正为 RGB。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PixelFormat {
    /// Windows GDI `BitBlt`/`GetDIBits` 原生格式（top-down）。
    Bgra,
    /// 已纠正为 RGB（OCR 消费侧）。
    Rgb,
}

/// 原始截图位图（未编码）。`data` 长度必须恒等于 `width * height * 4`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    pub format: PixelFormat,
}

impl RawImage {
    /// 校验 `data` 长度与尺寸是否匹配（防 OCR 阶段越界）。
    pub fn has_expected_len(&self) -> bool {
        self.data.len() == self.width as usize * self.height as usize * 4
    }
}

/// 单个显示器的几何信息（虚拟屏坐标，副屏可负）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorInfo {
    pub index: usize,
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

/// 截图目标：主显示器 / 区域 / 指定显示器 / 全部显示器合并 / 光标所在显示器。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CaptureTarget {
    /// 主显示器全屏。
    Primary,
    /// 左上角 + 尺寸的区域。
    Region { x: i32, y: i32, w: i32, h: i32 },
    /// 指定索引显示器（0-based）。
    Monitor { index: usize },
    /// 全部显示器合并的虚拟屏。
    All,
    /// 光标当前所在显示器。
    Active,
}
