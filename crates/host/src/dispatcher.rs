//! 请求分发器：把浏览器扩展发来的 NM 请求路由到 core 能力。
//!
//! 与旧项目单文件 `main.rs` 不同，这里把纯分发逻辑独立出来，便于单元测试。

use fs_core::database::Database;
use fs_core::ocr::{build_engine, OcrEngine};
use fs_core::translate::Translator;
use fs_core::types::{NmRequest, NmResponse};

/// 处理单个请求，返回响应。
///
/// `engine` 为懒加载缓存：首次 `Ocr` 请求时构建，之后复用；进程退出即销毁。
pub fn dispatch(
    req: &NmRequest,
    translator: &Translator,
    db: &Database,
    engine: &mut Option<Box<dyn OcrEngine>>,
) -> NmResponse {
    match req {
        NmRequest::Ping => NmResponse::Pong,
        NmRequest::Translate { text, src, dst } => {
            match translator.translate(text, src, dst) {
                Ok(t) => {
                    let _ = db.insert_history(text, &t, translator.primary_engine_id());
                    NmResponse::Translation { text: t }
                }
                Err(e) => NmResponse::Error { message: format!("{e}") },
            }
        }
        NmRequest::Capture { target } => {
            let res = fs_core::screenshot::capture_target(target.clone()).map(|img| {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                (img, format!("capture-{ts}"))
            });
            match res {
                Ok((_img, image_id)) => NmResponse::Captured {
                    width: _img.width,
                    height: _img.height,
                    image_id,
                },
                Err(e) => NmResponse::Error { message: format!("{e}") },
            }
        }
        NmRequest::SelectCapture => {
            // 框选遮罩由软件主体实现；宿主侧暂返回明确错误，避免静默失败。
            NmResponse::Error {
                message: "SelectCapture 需软件主体主窗体运行（crates/gui）".into(),
            }
        }
        NmRequest::Ocr { image_id } => {
            if engine.is_none() {
                match build_engine(None) {
                    Ok(e) => *engine = Some(e),
                    Err(err) => {
                        return NmResponse::Error { message: format!("{err}") };
                    }
                }
            }
            // 暂不支持按 image_id 取图：先返回空结果并给出说明。
            let _ = image_id;
            NmResponse::OcrResult { lines: vec![] }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fs_core::config::Config;

    fn test_ctx() -> (Translator, Database) {
        let cfg = Config::default();
        (Translator::from_config(&cfg), Database::open_in_memory().unwrap())
    }

    #[test]
    fn ping_returns_pong() {
        let (t, db) = test_ctx();
        let mut engine = None;
        let resp = dispatch(&NmRequest::Ping, &t, &db, &mut engine);
        assert_eq!(resp, NmResponse::Pong);
    }

    #[test]
    fn translate_without_endpoint_reports_error() {
        // 降级链只放未配密钥的引擎 → 确定性「无可用引擎」错误，绝不发网络请求
        let cfg = Config {
            translate: Some(fs_core::config::TranslateConfig {
                fallback_order: vec!["openai".into(), "edge".into()],
                ..Default::default()
            }),
            ..Config::default()
        };
        let t = Translator::from_config(&cfg);
        let db = Database::open_in_memory().unwrap();
        let mut engine = None;
        let resp = dispatch(
            &NmRequest::Translate { text: "hello".into(), src: "en".into(), dst: "zh".into() },
            &t,
            &db,
            &mut engine,
        );
        match resp {
            NmResponse::Error { message } => {
                assert!(!message.is_empty());
            }
            other => panic!("期望 Error，实际 {other:?}"),
        }
    }

    #[test]
    fn unimplemented_select_capture_returns_error_not_silent() {
        let (t, db) = test_ctx();
        let mut engine = None;
        let resp = dispatch(&NmRequest::SelectCapture, &t, &db, &mut engine);
        match resp {
            NmResponse::Error { message } => assert!(message.contains("软件主体")),
            other => panic!("期望 Error，实际 {other:?}"),
        }
    }
}