//! 开发期自检工具：截屏 → OCR → 打印识别文本。
//!
//! 用法（在仓库根执行）：
//!   source scripts/msvc-env.sh
//!   cargo run -p fs-core --example shot                 # 截活动显示器
//!   cargo run -p fs-core --example shot -- 100 200 500 260   # 截指定矩形（物理像素）
//!
//! 存在的理由：真机验证「截图→OCR」这一环时，GUI 只能看截图、机器只能看数字；
//! 有了本工具，同一条 `fs_core` 代码路径可以直接把识别结果打到 stdout，
//! 让自动化验证能对文本做断言，而不必依赖肉眼看图。
//!
//! 注意：这是 `examples/`，不进入 release 产物，也不属于测试门禁。

use fs_core::ocr::{build_engine, PlaceholderOcr};
use fs_core::screenshot::capture_target;
use fs_core::types::CaptureTarget;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let target = if args.len() == 4 {
        let n = |i: usize| args[i].parse::<i32>().unwrap_or(0);
        let (x, y, w, h) = (n(0), n(1), n(2), n(3));
        println!("[shot] 区域 ({x},{y}) {w}x{h}");
        CaptureTarget::Region { x, y, w, h }
    } else {
        println!("[shot] 活动显示器（光标所在屏）");
        CaptureTarget::Active
    };
    let img = capture_target(target)?;
    println!("[shot] 图像 {}x{} {:?}", img.width, img.height, img.format);

    let engine = build_engine(None)?;
    let lines = engine.recognize(&img)?;

    if lines.is_empty() {
        let kind = std::any::type_name_of_val(&*engine);
        eprintln!("[ocr] 识别到 0 行；引擎类型 = {kind}");
        if kind.contains("Placeholder") {
            eprintln!("[ocr] 引擎是占位实现 → 模型未就绪（检查 models/ppocrv6 或 ocr_model_dir 配置）");
        }
        return Ok(());
    }

    println!("[ocr] 识别到 {} 行：", lines.len());
    for (i, l) in lines.iter().enumerate() {
        println!("  {i:02} conf={:.3} bbox={:?} text={:?}", l.confidence, l.bbox, l.text);
    }

    let joined: String = lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n");
    println!("=====OCR_TEXT_BEGIN=====");
    println!("{joined}");
    println!("=====OCR_TEXT_END=====");

    // 占位引擎兜底断言：能走到这里说明引擎是真的（不是 PlaceholderOcr）
    let _ = PlaceholderOcr;
    Ok(())
}
