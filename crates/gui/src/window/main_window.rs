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
use fs_core::hotkey::{spawn_hotkey_loop_with_warn, HotkeyAction, HotkeyHandle};
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
    /// 最近一次**实际服务翻译**的引擎 id。
    ///
    /// 必要性：降级链会在首选引擎缺密钥/超时时静默落到下一个，只显示配置
    /// 链首项会与实际不符（用户会以为在用 SiliconFlow，其实跑的是 MyMemory）。
    pub engine: String,
    /// 实际引擎在配置降级链中的位置（1-based）；不在链中则 0。
    pub engine_position: usize,
    /// 配置降级链总长度。
    pub engine_chain_len: usize,
    /// 本次翻译前有几个引擎尝试失败（0 = 首选引擎一次成功）。
    pub engines_tried: usize,
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
    /// 划词浮窗是否正在显示（全局唯一）。
    ///
    /// 与 `pipeline_busy` 分开：划词不截图不 OCR，两者互不冲突，混用会导致
    /// 「刚截完图就按划词被静默丢弃」。独立标记让连按 Alt+T 只保留一个浮窗。
    pub word_bubble_active: Arc<AtomicBool>,
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
            word_bubble_active: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 更新配置并热重载依赖（保存到磁盘 + 重建翻译器 + 重建 OCR 引擎）。
    pub fn update_config(&self, cfg: Config) -> Result<()> {
        config::save(&cfg)?;
        crate::log::line("config: saved to disk");
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
        // 诊断：保存链路此前完全无日志，失败时用户只看到「按了没反应」。
        // 尤其 ocr::build_engine 失败会直接让整个保存失败（`?`），必须留痕。
        crate::log::line(&format!(
            "config: reloaded (ocr_ready={ready}, hotkeys={:?})",
            cfg.hotkeys
        ));
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
                            // catch_unwind：管线内若发生未预期 Rust panic，
                            // 由「静默退出」变为「记日志 + 报错事件」，便于定位 #5。
                            let pipe = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                st2.run_translation_pipeline_with("auto", "zh")
                            }));
                            match pipe {
                                Ok(Ok((orig, t))) => {
                                    crate::log::line(&format!(
                                        "worker: pipeline ok (orig {} chars / trans {} chars)",
                                        orig.chars().count(),
                                        t.chars().count()
                                    ));
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
                                Ok(Err(e)) => {
                                    crate::log::line(&format!("worker: pipeline err {e}"));
                                    let _ = appc3.emit("translation-error", e);
                                }
                                Err(_) => {
                                    crate::log::line("worker: pipeline PANIC 被捕获（详见上方日志）");
                                    let _ = appc3.emit("translation-error", "翻译管线内部错误（已记录日志）");
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
                            // catch_unwind：同整屏管线，未预期 panic 由静默退出转为记日志 + 报错。
                            let pipe = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                st2.run_translation_pipeline_with_target(target, "auto", "zh")
                            }));
                            match pipe {
                                Ok(Ok((orig, t))) => {
                                    crate::log::line(&format!(
                                        "worker(region): ok (orig {} / trans {})",
                                        orig.chars().count(),
                                        t.chars().count()
                                    ));
                                    let payload = serde_json::json!({
                                        "source": orig,
                                        "translation": t,
                                    });
                                    match appc3.emit("translation-ready", payload) {
                                        Ok(()) => crate::log::line("worker(region): emit translation-ready ok"),
                                        Err(e) => crate::log::line(&format!("worker(region): emit 失败 {e}")),
                                    }
                                }
                                Ok(Err(e)) => {
                                    crate::log::line(&format!("worker(region): err {e}"));
                                    let _ = appc3.emit("translation-error", e);
                                }
                                Err(_) => {
                                    crate::log::line("worker(region): pipeline PANIC 被捕获（详见上方日志）");
                                    let _ = appc3.emit("translation-error", "翻译管线内部错误（已记录日志）");
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
                "cycle_engine" => {
                    let appc2 = appc.clone();
                    Box::new(move || {
                        crate::log::line("hotkey: cycle_engine triggered");
                        // 不进管线（只改配置），故无需 pipeline_busy 重入保护，
                        // 也不需要 spawn 线程：轮换是纯内存操作 + 一次落盘，耗时微秒级。
                        // 仍放到线程里，避免落盘 IO 挡住 Win32 消息泵。
                        let appc3 = appc2.clone();
                        std::thread::spawn(move || {
                            let st = appc3.state::<AppState>();
                            let (new_primary, new_order) = {
                                let tr = st.translator.lock().unwrap();
                                match tr.cycle_primary() {
                                    Some(v) => v,
                                    None => {
                                        crate::log::line(
                                            "hotkey(cycle): 可用引擎不足 2 个，无法切换",
                                        );
                                        return;
                                    }
                                }
                            };
                            // 落盘 + 重建 translator + 热重载热键表
                            let mut cfg = st.config.lock().unwrap().clone();
                            if let Some(t) = cfg.translate.as_mut() {
                                t.fallback_order = new_order.clone();
                            }
                            if let Err(e) = st.update_config(cfg) {
                                crate::log::line(&format!("hotkey(cycle): 写配置失败 {e}"));
                                return;
                            }
                            if let Err(e) = st.reload_global_hotkeys(&appc3) {
                                crate::log::line(&format!("hotkey(cycle): 重载热键失败 {e}"));
                            }
                            crate::log::line(&format!(
                                "hotkey(cycle): 新首选={} chain=[{}]",
                                new_primary,
                                new_order.join(" → ")
                            ));
                            // 通知前端刷新状态栏
                            let _ = appc3.emit("engine-cycled", new_primary);
                        });
                    })
                }
                "selection_translate_word" => {
                    let appc2 = appc.clone();
                    Box::new(move || {
                        crate::log::line("hotkey(word): selection_translate_word triggered");
                        // 划词与截图管线互不冲突（不截图、不 OCR），故**不共用**
                        // pipeline_busy——否则用户连按 Alt+T 时第二次会被静默丢弃。
                        // 但浮窗本身全局唯一，需独立去重：已有浮窗在时直接忽略。
                        let st = appc2.state::<AppState>();
                        if st
                            .word_bubble_active
                            .swap(true, std::sync::atomic::Ordering::SeqCst)
                        {
                            crate::log::line("hotkey(word): 浮窗已在显示，忽略本次触发");
                            return;
                        }
                        let appc3 = appc2.clone();
                        std::thread::spawn(move || {
                            // ① 取词。UIA 主路径 → 剪贴板兜底（阶段 A 已实现）。
                            //    失败则降级到截屏 OCR（B4 阶段做），本阶段只记日志。
                            let sel = match fs_core::wordpick::read_selection() {
                                Ok(s) => s,
                                Err(e) => {
                                    crate::log::line(&format!(
                                        "hotkey(word): 取词失败（应降级到截屏 OCR，B4 实现）: {e}"
                                    ));
                                    st2_word_bubble_reset(&appc3);
                                    return;
                                }
                            };
                            crate::log::line(&format!(
                                "hotkey(word): 取词成功 source={} chars={}",
                                sel.source,
                                sel.text.chars().count()
                            ));
                            let selected = sel.text.clone();

                            // ② 显示小气泡。**必须**在 worker 线程里跑：
                            //    show_bubble 内部创建窗口并跑自己的消息循环，
                            //    放消息泵线程会卡死所有热键。
                            //    锚点用 None —— 取词接口（阶段 A）不返回选区坐标，
                            //    浮窗内部回落到光标位置；将来接精确坐标只改
                            //    word_bubble::locate_bubble 一处。
                            let content = crate::window::word_bubble::BubbleContent {
                                source: selected,
                                translation: String::new(),
                                error: None,
                            };
                            let appc3_translate = appc3.clone();
                            let appc3_dismiss = appc3;
                            crate::window::word_bubble::show_bubble(
                                None,
                                content,
                                // 翻译回调：**走 Translator 降级链**（不绕开）。
                                Box::new(move |text: &str| {
                                    let st = appc3_translate.state::<AppState>();
                                    let tr = st.translator.lock().unwrap();
                                    match tr.translate(text, "auto", "zh") {
                                        Ok(t) => Ok(t),
                                        Err(e) => {
                                            crate::log::line(&format!(
                                                "hotkey(word): 降级链翻译失败 {e}"
                                            ));
                                            Err(format!("翻译失败: {e}"))
                                        }
                                    }
                                }),
                                Box::new(move || {
                                    st2_word_bubble_reset(&appc3_dismiss);
                                }),
                            );
                        });
                        crate::log::line("hotkey(word): dispatched");
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
        match spawn_hotkey_loop_with_warn(actions, |msg| crate::log::line(&format!("hotkey: {msg}"))) {
            Ok(h) => {
                *self.hotkey_handle.lock().unwrap() = Some(h);
                crate::log::line("hotkeys: registered");
                Ok(())
            }
            Err(e) => {
                crate::log::line(&format!("hotkeys: spawn failed: {e}"));
                Err(e)
            }
        }
    }

    /// 调用翻译编排器：按配置降级链选引擎（本地 LLM / MyMemory / Google / 云端）。
    ///
    /// 不再直接调 LlmClient——那样只会走本地 LLM，云引擎永远用不上（原死代码路径）。
    /// 改为锁定已构造好的 [`Translator`] 注册表，复用 `AppState::new` / `update_config`
    /// 里建好的实例，零额外开销。
    pub fn translate(&self, text: &str, src: &str, dst: &str) -> Result<String> {
        let o = self.translate_detailed(text, src, dst)
            .map_err(fs_core::AppError::Translate)?;
        // 「重新翻译」也计入历史，保持历史抽屉与真实使用一致。
        if let Ok(db) = history_db() {
            if let Err(e) = db.insert_history(text, &o.text, &o.engine) {
                crate::log::line(&format!("translate: 历史写入失败（已忽略）: {e}"));
            }
        }
        Ok(o.text)
    }

    /// 同 [`Self::translate`]，但回报**实际服务引擎**（降级链可能静默换引擎）。
    pub fn translate_detailed(
        &self,
        text: &str,
        src: &str,
        dst: &str,
    ) -> std::result::Result<fs_core::translate::TranslationOutcome, String> {
        let tr = self.translator.lock().unwrap();
        tr.translate_detailed(text, src, dst)
            .map_err(|e| e.to_string())
    }

    /// 本地图片 OCR：解码 base64 图片 → OCR → 复用 [`Self::pipeline_after_ocr`] 翻译落库。
    ///
    /// 与截图管线共用同一收尾（翻译/回填/历史），保证两条入口行为一致。
    /// `base64` 为 PNG/JPG 等常见位图的 base64 文本（不含 `data:` 前缀也可）。
    pub fn translate_image_bytes(
        &self,
        base64_data: &str,
        src: &str,
        dst: &str,
    ) -> std::result::Result<(String, String), String> {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_data.trim())
            .map_err(|e| format!("图片解码失败: {e}"))?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("图片读取失败: {e}"))?;
        let rgba = img.to_rgba8();
        let raw = fs_core::types::RawImage {
            width: rgba.width(),
            height: rgba.height(),
            data: rgba.into_raw(),
            format: fs_core::types::PixelFormat::Rgba,
        };
        let lines = self
            .ocr
            .lock()
            .unwrap()
            .recognize(&raw)
            .map_err(|e| format!("识别失败: {e}"))?;
        let text: String = lines
            .iter()
            .map(|l| l.text.clone())
            .collect::<Vec<_>>()
            .join("\n");
        crate::log::line(&format!(
            "image: ocr {} lines / {} chars",
            lines.len(),
            text.chars().count()
        ));
        if text.trim().is_empty() {
            return Err("图片中未识别到文字".into());
        }
        // OCR 成功先落盘原文：翻译可能失败，但原文至少可见，便于排查。
        if let Ok(mut g) = self.gui_result.lock() {
            g.original = text.clone();
            g.source_lang = src.to_string();
            g.updated_at_ms = now_ms();
        }
        self.pipeline_after_ocr(&text, src, dst)
    }

    /// 多轮对话：转交 [`Translator::chat`]，由可用的 OpenAI 兼容引擎（SiliconFlow / OpenAI）应答。
    pub fn chat(&self, messages: &[fs_core::translate::ChatMessage]) -> Result<String> {
        let tr = self.translator.lock().unwrap();
        tr.chat(messages)
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
    /// 但 2026-10-03 起主程序已无框选入口——GUI 只走 `Active`（活动显示器整屏）。
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
        // 3~5 步：翻译 + 落共享结果 + 落历史库（与「本地图片 OCR」共用同一收尾路径）。
        self.pipeline_after_ocr(&text, src, dst)
    }

    /// OCR 得到原文之后的共用收尾：翻译 → 写入共享结果 → 落历史库。
    ///
    /// 截图管线与「本地图片 OCR」都只负责「把图像变成 `text`」，之后这同一段
    /// 决定翻译、回填、落库，避免两处各写一份导致历史/引擎信息不一致。
    fn pipeline_after_ocr(
        &self,
        text: &str,
        src: &str,
        dst: &str,
    ) -> std::result::Result<(String, String), String> {
        // 3. 翻译
        //    短路：OCR 出来的已经是中文、目标也是中文时**不要**发请求——
        //    MyMemory / Google 会回 403「PLEASE SELECT TWO DISTINCT LANGUAGES」，
        //    降级链一路失败，用户看到「翻译失败」，而实际上只是无需翻译。
        //    走 detailed 版以拿到「实际服务引擎」，写入共享结果供状态栏显示。
        let outcome = if fs_core::lang::is_chinese_target(dst) && fs_core::lang::is_mostly_cjk(text) {
            crate::log::line("pipe: 原文已是中文，跳过翻译直接回填");
            fs_core::translate::TranslationOutcome {
                text: text.to_string(),
                engine: "none".into(),
                position: None,
                chain_len: 0,
                tried: 0,
            }
        } else {
            // 错误信息里只带原文前 60 字：整段回填会把日志文件淹掉，
            // 让真正有用的结构化日志行被埋在几百行 OCR 文本里（2026-10-03 踩过）。
            let preview: String = text.chars().take(60).collect();
            let o = self
                .translate_detailed(text, src, dst)
                .map_err(|e| format!("翻译失败: {e}（原文前 60 字：{preview}）"))?;
            crate::log::line(&format!(
                "pipe: translated {} chars by engine={} (chain {}/{})",
                o.text.chars().count(),
                o.engine,
                o.position.unwrap_or(0),
                o.chain_len
            ));
            o
        };
        let t = outcome.text.clone();
        // 4. 写入共享结果
        if let Ok(mut g) = self.gui_result.lock() {
            g.original = text.to_string();
            g.translation = t.clone();
            g.source_lang = src.to_string();
            g.engine = outcome.engine.clone();
            g.engine_position = outcome.position.unwrap_or(0);
            g.engine_chain_len = outcome.chain_len;
            g.engines_tried = outcome.tried;
            g.updated_at_ms = now_ms();
        }
        // 5. 落历史库：每次完整翻译（含「已是中文跳过」）都记录，供历史抽屉回溯。
        //    写入失败只记日志、绝不影响主流程——历史是辅助能力，不能拖垮翻译。
        if let Ok(db) = history_db() {
            if let Err(e) = db.insert_history(text, &t, &outcome.engine) {
                crate::log::line(&format!("pipe: 历史写入失败（已忽略）: {e}"));
            }
        }
        Ok((text.to_string(), t))
    }
}

fn ocr_models_ready(dir: Option<&str>) -> bool {
    fs_core::ocr_models::load_models(dir)
        .map(|m| m.ready())
        .unwrap_or(false)
}

/// 清除「划词浮窗正在显示」标记。
///
/// 必须从浮窗的关闭路径（`on_dismiss`）与取词失败路径**都**调用，
/// 否则一次取词失败就会让后续所有划词热键被静默丢弃（标记永不复位）。
fn st2_word_bubble_reset(app: &AppHandle) {
    let st = app.state::<AppState>();
    st.word_bubble_active
        .store(false, std::sync::atomic::Ordering::SeqCst);
    crate::log::line("hotkey(word): 浮窗标记已复位");
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