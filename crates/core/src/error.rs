//! 统一错误类型（M6）。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON 错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("截图失败: {0}")]
    Capture(String),
    #[error("OCR 失败: {0}")]
    Ocr(String),
    #[error("翻译失败: {0}")]
    Translate(String),
    #[error("配置错误: {0}")]
    Config(String),
    #[error("已有实例在运行")]
    AlreadyRunning,
    #[error("消息帧过大: {0} 字节（上限 16 MiB）")]
    FrameTooLarge(usize),
    #[error("浮窗渲染失败: {0}")]
    Overlay(String),
    #[error("控制通道鉴权失败: {0}")]
    Auth(String),
}

pub type Result<T> = std::result::Result<T, AppError>;
