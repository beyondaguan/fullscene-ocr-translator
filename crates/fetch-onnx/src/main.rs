//! 为 fs-gui 准备 onnxruntime.dll（纯 Rust，替代原 `scripts/fetch_onnxruntime.py`）。
//!
//! ## 为什么需要
//!
//! `ort-sys 2.0.0-rc.13` 起不再分发 DLL；项目开 `load-dynamic`（规避 ct2rs 与 ort
//! 各自静态编译 protobuf 的符号重复），转为运行时 dlopen `onnxruntime.dll`。
//! feature 全局传导，PP-OCRv6 的 OCR 推理同样走动态加载，缺 DLL 会导致截图 OCR
//! 运行时静默失败（不是链接期错误，极易漏掉）。
//!
//! ## 用法
//!
//! ```text
//! cargo run -p fetch-onnx             # 缺失时才下载
//! cargo run -p fetch-onnx -- --force  # 强制重新下载
//! cargo run -p fetch-onnx -- --check  # 只检查，不下载
//! ```
//!
//! 下载源按顺序尝试（国内镜像优先），解压后写入 `target/debug/`（exe 同级目录）。
//! ORT API version 要求 >= 17（对应 ONNX Runtime 1.18+），固定 1.23.0。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::Context;

const ORT_VERSION: &str = "1.23.0";
const ARCHIVE: &str = "onnxruntime-win-x64-1.23.0.zip";

/// 镜像 URL 列表（国内镜像优先，实测 ghfast.top 可用）。
fn mirrors() -> Vec<String> {
    let base = format!(
        "https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VERSION}/{ARCHIVE}"
    );
    vec![
        format!("https://ghfast.top/{base}"),
        format!("https://ghproxy.net/{base}"),
        base,
    ]
}

// 只放这两个：providers_shared 是 EP 加载器；DirectML 本项目不用。
const WANTED: [&str; 2] = ["onnxruntime.dll", "onnxruntime_providers_shared.dll"];

/// exe 同级目录：`<workspace 根>/target/debug`。
/// `CARGO_MANIFEST_DIR` = `<根>/crates/fetch-onnx`，向上两级即 workspace 根。
fn dest_dir() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("target")
        .join("debug")
}

fn have_dll(dest: &Path) -> bool {
    WANTED.iter().all(|n| dest.join(n).exists())
}

fn check(dest: &Path) -> anyhow::Result<bool> {
    if !have_dll(dest) {
        let missing: Vec<&str> = WANTED
            .iter()
            .filter(|n| !dest.join(n).exists())
            .copied()
            .collect();
        println!("[fetch] 缺失: {missing:?} @ {}", dest.display());
        return Ok(false);
    }
    for n in WANTED {
        let size = dest.join(n).metadata()?.len();
        println!("[fetch] OK {n} ({:.1} MB)", size as f64 / 1024.0 / 1024.0);
    }
    Ok(true)
}

fn download(cache: &Path) -> anyhow::Result<PathBuf> {
    if let Some(parent) = cache.parent() {
        fs::create_dir_all(parent)?;
    }
    for url in mirrors() {
        println!("[fetch] 尝试 {url}");
        match ureq::get(&url)
            .set("User-Agent", "Mozilla/5.0")
            .call()
        {
            Ok(resp) => {
                let mut reader = resp.into_reader();
                let mut file = fs::File::create(cache)
                    .with_context(|| format!("创建缓存文件失败: {}", cache.display()))?;
                let copied = io::copy(&mut reader, &mut file)?;
                println!(
                    "[fetch] 下载完成 {:.1} MB -> {}",
                    copied as f64 / 1024.0 / 1024.0,
                    cache.display()
                );
                return Ok(cache.to_path_buf());
            }
            Err(e) => {
                println!("[fetch]   失败: {e}");
            }
        }
    }
    anyhow::bail!("[fetch] 全部镜像均失败，请手动下载并解压到 target/debug/")
}

fn extract(zip_path: &Path, dest: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(dest)?;
    let file = fs::File::open(zip_path)
        .with_context(|| format!("打开 zip 失败: {}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let base = Path::new(entry.name())
            .file_name()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if WANTED.contains(&base.as_str()) {
            let out = dest.join(&base);
            let mut out_file = fs::File::create(&out)
                .with_context(|| format!("创建输出文件失败: {}", out.display()))?;
            io::copy(&mut entry, &mut out_file)?;
            let size = out.metadata()?.len();
            println!(
                "[fetch] 解压 {} -> {} ({:.1} MB)",
                base,
                out.display(),
                size as f64 / 1024.0 / 1024.0
            );
        }
    }
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let force = args.iter().any(|a| a == "--force");
    let check_only = args.iter().any(|a| a == "--check");

    let dest = dest_dir();
    let cache = std::env::temp_dir().join(ARCHIVE);

    if check_only {
        if check(&dest)? {
            return Ok(());
        }
        std::process::exit(1);
    }

    if !force && check(&dest)? {
        println!("[fetch] 已存在，跳过（--force 可强制重下）: {}", dest.display());
        return Ok(());
    }

    let zip_path = download(&cache)?;
    extract(&zip_path, &dest)?;
    check(&dest)?;
    Ok(())
}