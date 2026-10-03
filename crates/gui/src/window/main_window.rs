//! 主窗体状态与截图翻译管线。
//!
//! 四页面 UI 由 `shared-ui`（React）在 WebView2 中渲染；本模块只负责 Rust 侧：
//! 配置、OCR 引擎、翻译结果共享缓冲、热键触发的「截图→OCR→翻译」管线。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use fs_core::config::{self, Config};
use fs_core::database::Database;
use fs_core::error::Result;
use fs_core::hotkey::{spawn_hotkey_loop, HotkeyAction, HotkeyHandle};
use fs_core::ocr::{self, OcrEngine};
use fs_core::translate::Translator;
use fs_core::types::CaptureTarget;
use tauri::{AppHandle, Emitter, Manager};

/// 主窗体窗口标签（与 `tauri.conf.json` / `window/mod.rs` 一致）。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 一次「截图→OCR→翻译」的结果快照，供前端轮询读取。
#[derive(Debug, Clone, Default)]
pub struct PipelineResult {
    /// 原文（OCR 识别出的文字，或用户粘贴的文本）
    pub original: String,
    /// 译文
    pub translation: String,
    /// 源语言提示（"auto" 表示自动识别）
    pub source_lang: String,
    /// 最近一次更新时间戳（毫秒），前端据此判断是否有新结果
    pub updated_at_ms: u64,
}

impl PipelineResult {
    pub fn empty() -> Self {
        Self::default()
    }
}

/// 主窗体共享状态（由 Tauri 管理）。
pub struct AppState {
    /// 配置（加载于启动；保存时更新）
    pub config: Mutex<Config>,
    /// OCR 引擎（懒加载；模型缺失时降级为占位）
    pub ocr: Mutex<Box<dyn OcrEngine>>,
    /// PP-OCRv6 是否真正就绪（false = 模型缺失，OCR 已降级）
    pub ocr_ready: Mutex<bool>,
    /// 最新一次管线结果，前端轮询读取
    pub gui_result: Arc<Mutex<PipelineResult>>,
    /// 翻译路由器（本地 LLM 优先，云端降级）
    pub translator: Mutex<Translator>,
    /// 全局热键句柄（保存配置后热重载；None = 未注册）
    pub hotkey_handle: Mutex<Option<HotkeyHandle>>,
    /// 管线忙标记：一次「截图→OCR→翻译」未完成前，忽略后续热键触发。
    ///
    /// 必要性：整条管线实测耗时可达 38 秒（降级链上不可达引擎的超时叠加）。
    /// 若允许重入，多次按键会在消息泵里排队，用户看到的是「按了没反应」。
    pub pipeline_busy: Arc<AtomicBool>,
}

impl AppState {
    pub fn new() -> Self {
        let cfg = config::load().unwrap_or_default();
        let ocr_engine = match ocr::build_engine(cfg.ocr_model_dir.as_deref()) {
            Ok(e) => e,
            Err(_) => ocr::build_engine(None).unwrap_or_else(|_| Box::new(ocr::PlaceholderOcr)),
        };
        let ready = ocr_models_ready(cfg.ocr_model_dir.as_deref());
        Self {
            config: Mutex::new(cfg.clone()),
            ocr: Mutex::new(ocr_engine),
            ocr_ready: Mutex::new(ready),
            gui_result: Arc::new(Mutex::new(PipelineResult::empty())),
            translator: Mutex::new(Translator::from_config(&cfg)),
            hotkey_handle: Mutex::new(None),
            pipeline_busy: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 更新配置并热重载依赖（保存到磁盘 + 重建翻译器 + 重建 OCR 引擎）。
    pub fn update_config(&self, cfg: Config) -> Result<()> {
        config::save(&cfg)?;
        {
            let mut cur = self.config.lock().unwrap();
            *cur = cfg.clone();
        }
        {
            let mut tr = self.translator.lock().unwrap();
            *tr = Translator::from_config(&cfg);
        }
        let ready = ocr_models_ready(cfg.ocr_model_dir.as_deref());
        let engine = ocr::build_engine(cfg.ocr_model_dir.as_deref())?;
        {
            let mut e = self.ocr.lock().unwrap();
            *e = engine;
            let mut r = self.ocr_ready.lock().unwrap();
            *r = ready;
        }
        Ok(())
    }

    /// 临时挂起 / 恢复全局热键。
    ///
    /// 用途：设置页「录入热键」时必须挂起。否则用户按下 `Alt+Q` 的瞬间，
    /// 全局热键先于 DOM 的 keydown 弹出框选遮罩并抢走焦点，录入根本收不到这次按键。
    ///
    /// 挂起只是停掉监听线程（句柄置空），不改配置；恢复时按当前配置重新注册。
    /// 重复调用是幂等的：挂起态再挂起无副作用，恢复态再恢复也只是重注册一次。
    pub fn set_hotkeys_suspended(&self, app: &AppHandle, suspended: bool) -> Result<()> {
        if suspended {
            if let Some(h) = self.hotkey_handle.lock().unwrap().take() {
                h.stop();
                crate::log::line("hotkeys suspended (recorder listening)");
            }
        } else {
            self.reload_global_hotkeys(app)?;
            crate::log::line("hotkeys resumed");
        }
        Ok(())
    }

    /// 按 `Config.hotkeys`（缺省回落 [`config::DEFAULT_HOTKEYS`]）重建全局动作热键。
    ///
    /// 先停旧句柄（注销全部热键 + 结束线程），再为每个动作注册组合键并分发回调：
    /// - `fullscreen_translate` → 即时截活动显示器全屏 → OCR → 翻译，并广播 `translation-ready`
    ///
    /// 2026-10-03：`region_translate` 分支已移除（框选下线），旧配置里的残留动作被安全跳过。
    ///
    /// 在启动（`setup`）与保存配置（`save_config`）后调用，实现热重载，无需重启进程。
    pub fn reload_global_hotkeys(&self, app: &AppHandle) -> Result<()> {
        if let Some(h) = self.hotkey_handle.lock().unwrap().take() {
            h.stop();
        }
        let cfg = self.config.lock().unwrap().clone();
        let mut actions: Vec<HotkeyAction> = Vec::new();
        let mut id: u32 = 1;
        for &(action_id, default_combo) in config::DEFAULT_HOTKEYS {
            let combo = cfg
                .hotkeys
                .get(action_id)
                .cloned()
                .unwrap_or_else(|| default_combo.to_string());
            let appc = app.clone();
            // 不同动作对应不同触发逻辑；未知动作跳过。
            // 2026-10-03：`region_translate`（框选）分支已移除——overlay 全屏透明窗口
            // 从未真机验证通过且为崩溃源之一。用户在旧配置里残留的该动作会走到 `_ => continue`
            // 被安全跳过，不会注册成死热键、也不会崩。
            let trigger: Box<dyn Fn() + Send> = match action_id {
                "fullscreen_translate" => {
                    let appc2 = appc.clone();
                    Box::new(move || {
                        crate::log::line("hotkey: fullscreen_translate triggered");
                        // ① 重入保护：上一次还没跑完就直接忽略（不排队、不叠加超时）。
                        let st = appc2.state::<AppState>();
                        if st.pipeline_busy.swap(true, Ordering::SeqCst) {
                            crate::log::line("hotkey: 上一轮仍在进行，忽略本次触发");
                            return;
                        }
                        // ② 绝不在这个回调里跑管线：这里是 Win32 消息泵线程，
                        //    同步跑「GDI 截图 + ONNX 推理 + 网络翻译」实测会阻塞数十秒，
                        //    泵一旦不响应，热键/窗口消息全部停摆（真机表现为「像崩了」）。
                        let busy = Arc::clone(&st.pipeline_busy);
                        let appc3 = appc2.clone();
                        std::thread::spawn(move || {
                            crate::log::line("worker: start");
                            let st2 = appc3.state::<AppState>();
                            match st2.run_translation_pipeline_with("auto", "zh") {
                                Ok((orig, t)) => {
                                    crate::log::line(&format!(
                                        "worker: pipeline ok (orig {} chars / trans {} chars)",
                                        orig.chars().count(),
                                        t.chars().count()
                                    ));
                                    // 载荷与 selection_translate 分支保持一致：
                                    // 必须是 { source, translation } 对象，
                                    // 前端 main.tsx 按这两个字段读。
                                    match appc3.emit(
                                        "translation-ready",
                                        serde_json::json!({
                                            "source": orig,
                                            "translation": t,
                                        }),
                                    ) {
                                        Ok(()) => crate::log::line("worker: emit translation-ready ok"),
                                        Err(e) => crate::log::line(&format!("worker: emit err {e}")),
                                    }
                                }
                                Err(e) => {
                                    crate::log::line(&format!("worker: pipeline err {e}"));
                                    let _ = appc3.emit("translation-error", e);
                                }
                            }
                            busy.store(false, Ordering::SeqCst);
                            crate::log::line("worker: done");
                        });
                        crate::log::line("hotkey: dispatched");
                    })
                }
                "selection_translate" => {
                    let appc2 = appc.clone();
                    Box::new(move || {
                        crate::log::line("hotkey: selection_translate triggered");
                        let st = appc2.state::<AppState>();
                        if st.pipeline_busy.swap(true, Ordering::SeqCst) {
                            crate::log::line("hotkey(region): 上一轮仍在进行，忽略");
                            return;
                        }
                        let busy = Arc::clone(&st.pipeline_busy);
                        let appc3 = appc2.clone();
                        std::thread::spawn(move || {
                            crate::log::line("worker(region): 弹出十字框选");
                            // 框选前必须隐藏主窗口：pick_region 的冻结截图抓的是
                            // 当时的桌面画面，主窗口若在前台，它会被一起冻进背景里，
                            // 导致「框选主程序所在位置」时 OCR 读到的是旧界面内容。
                            // 同时也让用户能看到并框选主程序之外的区域。
                            let main_win = appc3.get_webview_window(MAIN_WINDOW_LABEL);
                            if let Some(w) = main_win.as_ref() {
                                if let Err(e) = w.hide() {
                                    crate::log::line(&format!("worker(region): 隐藏主窗口失败 {e}"));
                                }
                            }
                            // 无论后续是成功/取消/失败，都必须把主窗口恢复显示，
                            // 否则用户会看到一个「消失的应用」。
                            // 顺序同后文：先 unminimize 再 show。
                            let restore_main = move || {
                                if let Some(w) = main_win {
                                    if let Err(e) = w.unminimize() {
                                        crate::log::line(&format!("worker(region): 取消最小化失败 {e}"));
                                    }
                                    if let Err(e) = w.show() {
                                        crate::log::line(&format!("worker(region): 恢复主窗口失败 {e}"));
                                    }
                                }
                            };
                            // 阻塞直到用户框选完成/取消——必须在 worker 线程里跑：
                            // pick_region 内部要创建窗口并跑自己的消息循环。
                            let picked = match crate::window::region_picker::pick_region() {
                                Ok(p) => p,
                                Err(e) => {
                                    restore_main();
                                    crate::log::line(&format!("worker(region): 框选失败 {e}"));
                                    let _ = appc3.emit("translation-error", format!("框选失败: {e}"));
                                    busy.store(false, Ordering::SeqCst);
                                    return;
                                }
                            };
                            let Some(r) = picked else {
                                restore_main();
                                crate::log::line("worker(region): 用户取消框选");
                                busy.store(false, Ordering::SeqCst);
                                return;
                            };
                            crate::log::line(&format!(
                                "worker(region): 选中 {}x{} @({},{})",
                                r.w, r.h, r.x, r.y
                            ));
                            let st2 = appc3.state::<AppState>();
                            let target = CaptureTarget::Region { x: r.x, y: r.y, w: r.w, h: r.h };
                            match st2.run_translation_pipeline_with_target(target, "auto", "zh") {
                                Ok((orig, t)) => {
                                    crate::log::line(&format!(
                                        "worker(region): ok (orig {} / trans {})",
                                        orig.chars().count(),
                                        t.chars().count()
                                    ));
                                    // 事件载荷必须是 { source, translation } 对象：
                                    // 前端 main.tsx 按这两个字段读，之前这里只发了
                                    // 译文裸字符串，导致原文区与译文区都拿到 undefined。
                                    let _ = appc3.emit(
                                        "translation-ready",
                                        serde_json::json!({
                                            "source": orig,
                                            "translation": t,
                                        }),
                                    );
                                }
                                Err(e) => {
                                    crate::log::line(&format!("worker(region): err {e}"));
                                    let _ = appc3.emit("translation-error", e);
                                }
                            }
                            // 翻译完成后再显示并前置主窗口，让用户直接看到结果。
                            // 顺序：先 unminimize 再 show——tao 的 Show 走
                            // set_visible(true)/SW_SHOW，无法还原最小化状态，
                            // 若主窗口本来是最小化的，必须先解除最小化。
                            // 放在 emit 之后：先投递事件，再抢焦点，避免焦点切换
                            // 与前端 setState 竞争导致首帧丢事件。
                            if let Some(w) = appc3.get_webview_window(MAIN_WINDOW_LABEL) {
                                if let Err(e) = w.unminimize() {
                                    crate::log::line(&format!("worker(region): 取消最小化失败 {e}"));
                                }
                                if let Err(e) = w.show() {
                                    crate::log::line(&format!("worker(region): 显示主窗口失败 {e}"));
                                }
                                if let Err(e) = w.set_focus() {
                                    crate::log::line(&format!("worker(region): 聚焦主窗口失败 {e}"));
                                }
                            }
                            busy.store(false, Ordering::SeqCst);
                            crate::log::line("worker(region): done");
                        });
                        crate::log::line("hotkey(region): dispatched");
                    })
                }
                _ => continue,
            };
            actions.push(HotkeyAction {
                id,
                combo,
                on_trigger: trigger,
            });
            id += 1;
        }
        match spawn_hotkey_loop(actions) {
            Ok(h) => {
                *self.hotkey_handle.lock().unwrap() = Some(h);
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    /// 调用翻译编排器：按配置降级链选引擎（本地 LLM / MyMemory / Google / 云端）。
    ///
    /// 不再直接调 LlmClient——那样只会走本地 LLM，云引擎永远用不上（原死代码路径）。
    /// 改为锁定已构造好的 [`Translator`] 注册表，复用 `AppState::new` / `update_config`
    /// 里建好的实例，零额外开销。
    pub fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String> {
        let tr = self.translator.lock().unwrap();
        tr.translate(text, src, dst)
    }

    /// 完整管线：源/目标语言由调用方指定（默认 `"auto"`/`"zh"` 见 [`Self::screenshot_translate`](crate::commands)）。
    ///
    /// 前端命令条的语言选择器经此传入；返回 `(原文, 译文)`，两者都要回传前端——
    /// 工作区下半栏显示的就是这份 OCR 原文，不能只回译文。
    pub fn run_translation_pipeline_with(
        &self,
        src: &str,
        dst: &str,
    ) -> std::result::Result<(String, String), String> {
        // 默认截「光标所在显示器」（与全局热键即时截图同语义）
        self.run_translation_pipeline_with_target(CaptureTarget::Active, src, dst)
    }

    /// 按指定 [`CaptureTarget`] 跑完整管线：截图 → OCR → 翻译。
    ///
    /// [`CaptureTarget::Region`] 保留在 `fs-core`（数据层仍支持区域截图，供将来复用或扩展调用）；
    /// 但 2026-10-03 起软件主体已无框选入口——GUI 只走 `Active`（活动显示器整屏）。
    pub fn run_translation_pipeline_with_target(
        &self,
        target: CaptureTarget,
        src: &str,
        dst: &str,
    ) -> std::result::Result<(String, String), String> {
        crate::log::line("pipe: start");
        // 1. 截图（按目标：活动显示器 / 区域 / 指定显示器 …）
        let img = fs_core::screenshot::capture_target(target)
            .map_err(|e| format!("截图失败: {e}"))?;
        crate::log::line(&format!("pipe: captured {}x{}", img.width, img.height));
        // 2. OCR
        let lines = self
            .ocr
            .lock()
            .unwrap()
            .recognize(&img)
            .map_err(|e| format!("识别失败: {e}"))?;
        let text: String = lines
            .iter()
            .map(|l| l.text.clone())
            .collect::<Vec<_>>()
            .join("\n");
        crate::log::line(&format!("pipe: ocr {} lines / {} chars", lines.len(), text.chars().count()));
        if text.trim().is_empty() {
            return Err("未识别到文字".into());
        }
        // OCR 一旦成功就先落盘原文：翻译在它之后，且可能因引擎/网络失败。
        // 以前是「翻译失败 → 什么都不回填」，用户连 OCR 出来的原文都看不到，
        // 排错时也无法判断到底是 OCR 没识别到还是翻译挂了。
        if let Ok(mut g) = self.gui_result.lock() {
            g.original = text.clone();
            g.source_lang = src.to_string();
            g.updated_at_ms = now_ms();
        }
        // 3. 翻译
        //    短路：OCR 出来的已经是中文、目标也是中文时**不要**发请求——
        //    MyMemory / Google 会回 403「PLEASE SELECT TWO DISTINCT LANGUAGES」，
        //    降级链一路失败，用户看到「翻译失败」，而实际上只是无需翻译。
        let t = if fs_core::lang::is_chinese_target(dst) && fs_core::lang::is_mostly_cjk(&text) {
            crate::log::line("pipe: 原文已是中文，跳过翻译直接回填");
            text.clone()
        } else {
            // 错误信息里只带原文前 60 字：整段回填会把日志文件淹掉，
            // 让真正有用的结构化日志行被埋在几百行 OCR 文本里（2026-10-03 踩过）。
            let preview: String = text.chars().take(60).collect();
            let t = self
                .translate(&text, src, dst)
                .map_err(|e| format!("翻译失败: {e}（原文前 60 字：{preview}）"))?;
            crate::log::line(&format!("pipe: translated {} chars", t.chars().count()));
            t
        };
        // 4. 写入共享结果
        if let Ok(mut g) = self.gui_result.lock() {
            g.original = text.clone();
            g.translation = t.clone();
            g.source_lang = src.to_string();
            g.updated_at_ms = now_ms();
        }
        Ok((text, t))
    }
}

fn ocr_models_ready(dir: Option<&str>) -> bool {
    fs_core::ocr_models::load_models(dir)
        .map(|m| m.ready())
        .unwrap_or(false)
}

/// 当前 Unix 毫秒时间戳（用于结果新鲜度判断）。
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 配置文件路径（供设置页展示）。
pub fn config_file_path() -> PathBuf {
    config::config_path().unwrap_or_default()
}

/// 打开历史库（`%APPDATA%/FullSceneOCR/fullscene.db`，见 PRODUCTION.md §6）。
pub fn history_db() -> Result<Database> {
    let path = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("FullSceneOCR")
        .join("fullscene.db");
    Database::open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipeline_result_empty_has_zero_timestamp() {
        let r = PipelineResult::empty();
        assert_eq!(r.updated_at_ms, 0);
        assert!(r.original.is_empty());
    }

    #[test]
    fn now_ms_is_positive() {
        assert!(now_ms() > 1_700_000_000_000);
    }

    #[test]
    fn app_state_constructs_with_placeholder_ocr() {
        let s = AppState::new();
        // 即使无模型，OCR 也是占位引擎而非空
        let ocr = s.ocr.lock().unwrap();
        assert!(ocr.as_ref().recognize(&fs_core::types::RawImage {
            width: 1,
            height: 1,
            data: vec![0; 4],
            format: fs_core::types::PixelFormat::Rgba,
        }).is_ok());
    }
}