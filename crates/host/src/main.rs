//! `fs-host`：**NM 桥**（Native Messaging 管道，扩展 ↔ 主程序）。
//! 注意：本 crate 是**通道**，不是「主程序」——主程序是 `crates/gui`（fs-gui）。
//!
//! 浏览器扩展经标准输入输出与该二进制通信（4 字节小端长度前缀 + UTF-8 JSON）。
//! NM 宿主名：`com.fullscene.ocr_translator`（**已写入注册表，禁止更改**，见 PRODUCTION.md §4）。
//! 本二进制在 Windows 上无控制台窗口（`windows_subsystem = "windows"`），
//! 生命周期由 stdin 管道驱动：Chrome 拉起 → 收到请求 → 分发 → stdin EOF 退出。

mod dispatcher;
mod protocol;

use std::io;
use std::io::{BufReader, BufWriter};

use fs_core::config;
use fs_core::database::Database;
use fs_core::error::{AppError, Result};
use fs_core::ocr::OcrEngine;
use fs_core::translate::Translator;

fn main() {
    // GUI 子系统：stdout 若被浏览器占用会因管道未连接而 panic。
    // 此处全部错误经 NM 协议帧回传给扩展，而非写入 stdout。
    match run() {
        Ok(()) => {}
        Err(e) => {
            let resp = fs_core::types::NmResponse::Error {
                message: format!("{e}"),
            };
            // 尽力回传错误；若对端已断开则忽略
            let mut w = BufWriter::new(io::stdout());
            let _ = protocol::write_message(&mut w, &resp);
        }
    }
}

fn run() -> Result<()> {
    let cfg = config::load()?;
    let translator = Translator::from_config(&cfg);
    // NM 桥为一次性进程：OCR 引擎懒加载，仅在收到 Ocr 请求时构建。
    // 常驻模型加载由主程序（fs-gui）负责，NM 桥不加载 30MB 模型。
    let db = Database::open_in_memory()?;

    let mut engine: Option<Box<dyn OcrEngine>> = None;
    let mut reader = BufReader::new(io::stdin());
    let mut writer = BufWriter::new(io::stdout());

    loop {
        let req = match protocol::read_message(&mut reader) {
            Ok(r) => r,
            Err(AppError::Io(e)) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                let resp = fs_core::types::NmResponse::Error { message: format!("{e}") };
                protocol::write_message(&mut writer, &resp)?;
                break;
            }
        };

        let resp = dispatcher::dispatch(
            &req,
            &translator,
            &db,
            &mut engine,
        );
        protocol::write_message(&mut writer, &resp)?;
    }
    Ok(())
}