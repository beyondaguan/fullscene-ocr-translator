//! Tauri 命令层：React 前端经 `invoke()` 调用的全部命令。
//!
//! 命名与 `shared-ui` 的 `useNativeMsg` / `api.ts` 对齐：
//! - `get_config` / `save_config`：设置抽屉读写
//! - `translate_text`：工作区「重新翻译」
//! - `screenshot_translate`：截图翻译管线（回传 OCR 原文 + 译文）
//! - `get_history` / `clear_history`：历史抽屉
//! - `ping`：连通性自检
//!
//! 2026-10-03：`open_selection` / `close_selection` / `selection_done` 已下线（见下方注释）。

use tauri::{AppHandle, State};

use fs_core::config::Config;

use crate::window::main_window::AppState;

/// 录入热键期间挂起 / 恢复全局热键。
///
/// 不挂起的话，用户在设置页按下 `Alt+Q` 的瞬间，全局热键会先弹出十字框选遮罩
/// 并抢走焦点，前端 keydown 收不到这次按键 → 永远录不进新键。
#[tauri::command]
pub fn set_hotkeys_suspended(
    app: AppHandle,
    state: State<'_, AppState>,
    suspended: bool,
) -> Result<(), String> {
    state
        .set_hotkeys_suspended(&app, suspended)
        .map_err(|e| e.to_string())
}

/// 配置 + 运行状态快照（设置页与状态栏使用）
#[derive(serde::Serialize)]
pub struct AppStatus {
    pub config: Config,
    pub ocr_ready: bool,
    pub config_path: String,
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Result<Config, String> {
    Ok(state.config.lock().unwrap().clone())
}

#[tauri::command]
pub fn save_config(app: AppHandle, state: State<'_, AppState>, config: Config) -> Result<(), String> {
    state
        .update_config(config)
        .map_err(|e| e.to_string())?;
    // 配置（含热键表）已落盘并刷新内存；热重载全局动作热键，无需重启。
    state
        .reload_global_hotkeys(&app)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_status(state: State<'_, AppState>) -> Result<AppStatus, String> {
    Ok(AppStatus {
        config: state.config.lock().unwrap().clone(),
        ocr_ready: *state.ocr_ready.lock().unwrap(),
        config_path: crate::window::main_window::config_file_path()
            .to_string_lossy()
            .to_string(),
    })
}

#[tauri::command]
pub fn ping() -> Result<String, String> {
    Ok("pong".into())
}

/// 设置抽屉「翻译引擎」：列出全部已注册引擎及可用状态（密钥是否配置）。
#[tauri::command]
pub fn list_engines(
    state: State<'_, AppState>,
) -> Result<Vec<fs_core::translate::EngineInfo>, String> {
    Ok(state.translator.lock().unwrap().list_engines())
}

/// 设置抽屉「测试此引擎」：指定引擎试译一句，返回译文或错误。
///
/// 注意走的是 `translate_with`（绕过降级链），测的就是该引擎本身。
#[tauri::command]
pub fn test_engine(
    state: State<'_, AppState>,
    id: String,
    text: Option<String>,
) -> Result<String, String> {
    let tr = state.translator.lock().unwrap();
    tr.translate_with(
        &id,
        text.as_deref().unwrap_or("Hello, world! This is a translation test."),
        "auto",
        "zh",
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn translate_text(
    state: State<'_, AppState>,
    text: String,
    src: String,
    dst: String,
) -> Result<String, String> {
    state.translate(&text, &src, &dst).map_err(|e| e.to_string())
}

/// 截图翻译：截取光标所在显示器 → OCR → 翻译。
///
/// 同时回传 OCR 原文与译文：工作区下半栏要显示原文，只回译文会让下半栏永远空白。
#[derive(serde::Serialize)]
pub struct ShotResult {
    pub source: String,
    pub translation: String,
}

#[tauri::command]
pub fn screenshot_translate(
    state: State<'_, AppState>,
    src: Option<String>,
    dst: Option<String>,
) -> Result<ShotResult, String> {
    let s = src.unwrap_or_else(|| "auto".into());
    let d = dst.unwrap_or_else(|| "zh".into());
    state
        .run_translation_pipeline_with(&s, &d)
        .map(|(source, translation)| ShotResult { source, translation })
}

/// 本地图片 OCR：前端把图片读成 base64 传进来，Rust 解码 → OCR → 翻译 → 回传原文+译文。
///
/// 走 [`AppState::translate_image_bytes`]，与截图管线共用同一翻译/落库路径，
/// 因此历史抽屉同样会记录这次图片翻译。
#[tauri::command]
pub fn translate_image_bytes(
    state: State<'_, AppState>,
    base64: String,
    src: Option<String>,
    dst: Option<String>,
) -> Result<ShotResult, String> {
    let s = src.unwrap_or_else(|| "auto".into());
    let d = dst.unwrap_or_else(|| "zh".into());
    state
        .translate_image_bytes(&base64, &s, &d)
        .map(|(source, translation)| ShotResult { source, translation })
}

/// 单条对话消息（AI 助手抽屉 → 后端）。
#[derive(serde::Deserialize)]
pub struct ChatMessageInput {
    pub role: String,
    pub content: String,
}

/// AI 对话：把完整对话历史交给可用的对话引擎（SiliconFlow / OpenAI）生成回复。
///
/// 与 `translate_text`（翻译）完全独立：这里走 `/v1/chat/completions`，保留多轮上下文，
/// 而非「把输入再翻译一遍」。无可用对话密钥时返回明确错误而非静默空响应。
#[tauri::command]
pub fn chat(
    state: State<'_, AppState>,
    messages: Vec<ChatMessageInput>,
) -> Result<String, String> {
    let msgs: Vec<fs_core::translate::ChatMessage> = messages
        .into_iter()
        .map(|m| fs_core::translate::ChatMessage {
            role: m.role,
            content: m.content,
        })
        .collect();
    state.chat(&msgs).map_err(|e| e.to_string())
}

// 2026-10-03：框选相关命令（open_selection / close_selection / selection_done）整体下线。
// 根因：overlay 依赖全屏透明 + 无边框 + 置顶窗口（tao/Windows），从未真机验证通过、
// 且为真机崩溃源之一；框选功能已从前端工具栏与快捷键一并移除。
// 整屏截图翻译的命令（screenshot_translate）不受影响，主链保持完整。
// 恢复路径：若将来重启框选，需先单独证明「全屏透明置顶 WebView2 窗口」在本机稳定，
// 再回填本区块与 `window/overlay.rs`（文件已删除，可从历史记录恢复）。

/// 读取最近 N 条翻译历史（欢迎页「最近翻译」）。
#[tauri::command]
pub fn get_history(state: State<'_, AppState>, limit: usize) -> Result<Vec<HistoryItem>, String> {
    let db = crate::window::main_window::history_db().map_err(|e| e.to_string())?;
    let rows = db.recent(limit).map_err(|e| e.to_string())?;
    let _ = &state;
    Ok(rows
        .iter()
        .map(|r| HistoryItem {
            id: r.id,
            source: r.source.clone(),
            target: r.target.clone(),
            engine: r.engine.clone(),
            created_at: r.created_at.clone(),
        })
        .collect())
}

/// 读取最近一次管线结果（原文 + 译文 + 源语言 + 时间戳）。
///
/// 存在的理由：`translation-ready` 是**单向事件**，桥未就绪、窗口重建或
/// 监听注册时序稍有偏差就会永久丢失，症状是「Rust 日志显示翻译成功，
/// 界面两个区都是 0 字」。本命令让前端能主动拉取权威状态，不依赖事件送达。
///
/// 独立于 [`ShotResult`]（后者是 `screenshot_translate` 的返回契约，字段更少），
/// 避免改动既有前端接口。
#[derive(serde::Serialize)]
pub struct PipelineSnapshot {
    pub source: String,
    pub translation: String,
    pub source_lang: String,
    pub updated_at_ms: u64,
    /// 最近一次实际服务翻译的引擎 id（状态栏显示用）
    pub engine: String,
    /// 该引擎在配置降级链中的位置（1-based，0 = 不在链中/无翻译发生）
    pub engine_position: usize,
    /// 配置降级链总长度
    pub engine_chain_len: usize,
    /// 本次翻译前有几个引擎尝试失败
    pub engines_tried: usize,
}

#[tauri::command]
pub fn get_result(state: State<'_, AppState>) -> Result<PipelineSnapshot, String> {
    let g = state
        .gui_result
        .lock()
        .map_err(|_| "结果锁已损坏".to_string())?;
    Ok(PipelineSnapshot {
        source: g.original.clone(),
        translation: g.translation.clone(),
        source_lang: g.source_lang.clone(),
        updated_at_ms: g.updated_at_ms,
        engine: g.engine.clone(),
        engine_position: g.engine_position,
        engine_chain_len: g.engine_chain_len,
        engines_tried: g.engines_tried,
    })
}

#[tauri::command]
pub fn clear_history() -> Result<(), String> {
    let db = crate::window::main_window::history_db().map_err(|e| e.to_string())?;
    db.clear().map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct HistoryItem {
    pub id: i64,
    pub source: String,
    pub target: String,
    pub engine: String,
    pub created_at: String,
}