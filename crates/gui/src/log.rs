//! 文件日志（诊断用）。
//!
//! 背景：真机上 `Ctrl+Alt+O` 会**静默**让进程消失——无 dump、无日志、无报错，
//! 无法定位。GUI 子系统构建（release）没有控制台，连 `eprintln!` 都看不到。
//! 因此把关键事件与 panic 全部落盘到 `%APPDATA%/FullSceneOCR/logs/fs-gui.log`。
//!
//! 设计取舍：只做「追加一行 + panic hook」，不引入 log crate / 不配置级别，
//! 保持零依赖、零配置，避免为诊断再引入一层复杂度。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

/// 日志文件路径（进程内只解析一次）。
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// 日志目录：`%APPDATA%/FullSceneOCR/logs`（取不到配置目录时回落当前目录）。
fn log_path() -> &'static PathBuf {
    LOG_PATH.get_or_init(|| {
        let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        let dir = base.join("FullSceneOCR").join("logs");
        let _ = fs::create_dir_all(&dir);
        dir.join("fs-gui.log")
    })
}

/// 追加一行日志（带毫秒时间戳）。日志失败绝不回传错误——诊断不能反过来拖垮业务。
pub fn line(msg: &str) {
    let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) else {
        return;
    };
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // 单行写入，避免多线程交错造成半行；写入失败静默忽略。
    let _ = writeln!(f, "{ms} {msg}");
    let _ = f.flush();
}

/// 安装 panic hook：把 panic 信息（含线程名与 backtrace）写进日志文件。
///
/// 关键价值：热键线程里的 panic 默认只打印到 stderr —— GUI 子系统下等于消失，
/// 且会让监听线程直接死掉（此后全局热键永久失效）。落盘后才能证明「是不是 panic」。
pub fn init() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>").to_string();
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let msg = match info.payload().downcast_ref::<&str>() {
            Some(s) => s.to_string(),
            None => match info.payload().downcast_ref::<String>() {
                Some(s) => s.clone(),
                None => "<non-string payload>".into(),
            },
        };
        line(&format!("PANIC thread={name} at={loc} msg={msg}"));
        line(&format!(
            "PANIC_BACKTRACE {}",
            std::backtrace::Backtrace::force_capture()
        ));
        // 保留默认行为（debug 下仍打印到 stderr，便于控制台构建观察）
        default(info);
    }));
    line("==== process start ====");
}
