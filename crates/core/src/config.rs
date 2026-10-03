//! 配置加载 / 保存（JSON，M6/M17）。

use std::collections::HashMap;

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};

/// 全局动作热键默认键（仅当 `Config.hotkeys` 未显式配置该动作时使用）。
/// 各动作语义见 `crates/gui/src/window/main_window.rs::GLOBAL_HOTKEY_ACTIONS`。
///
/// 2026-10-03 移除 `region_translate`（框选）：overlay 全屏透明窗口从未真机验证通过，
/// 且为真机崩溃源之一，功能整体下线（见 docs/项目规范.md §5.2 P1 与版本历史 1.26）。
/// 用户若曾配置该动作，热键表里的残留项会被 `reload_global_hotkeys` 忽略（无匹配分支）。
/// 默认全局热键表：`(动作 id, 组合键)`。
///
/// - `selection_translate`：**十字框选**截图翻译（主入口，默认 `Alt+Q`）
/// - `fullscreen_translate`：整屏即时翻译（无框选，默认 `Ctrl+Alt+O`）
///
/// ## 为什么只有一处注册（2026-10-03 统一为 Alt+Q 时定下的约束）
/// `RegisterHotKey` 是**进程级全局**的——窗口有焦点时它**照样触发**。
/// 所以「窗口内快捷键」与「窗口外全局热键」不需要、也**不能**各注册一份：
/// 前端若再 `useHotkey('Alt+Q')`，一次按键会命中两条路径，触发两次。
/// 因此统一由 Rust 侧注册一次，前端不注册该键；录入口径也只有设置页这一处。
///
/// 另一个理由：已实测 `window.__TAURI__` 未注入，页面内快捷键本来就收不到（见 §5.2 P1）。
///
/// - `cycle_engine`：把降级链里**可用**引擎的首选往后挪一位（即「换一个引擎用」）。
///   只轮换可用引擎，跳过缺密钥的，否则按一次可能落到一个永远不可用的项上。
pub const DEFAULT_HOTKEYS: &[(&str, &str)] = &[
    ("selection_translate", "Alt+Q"),
    ("fullscreen_translate", "Ctrl+Alt+O"),
    ("cycle_engine", "Ctrl+Alt+E"),
];

/// Translate 轴配置（M7 重构）：云引擎密钥 + 降级链。
///
/// 设计参照 WinOCR 3.4 的分区 typed 配置：缺密钥的引擎 `available()=false`，
/// 翻译路由器自动跳过，不发起网络请求、不静默失败。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranslateConfig {
    /// 降级链：引擎 id 顺序，首个 available 的引擎优先。
    #[serde(default)]
    pub fallback_order: Vec<String>,
    /// SiliconFlow API Key
    #[serde(default)]
    pub siliconflow_key: Option<String>,
    /// SiliconFlow 兼容 OpenAI 的 base_url（默认官方）
    #[serde(default)]
    pub siliconflow_base_url: Option<String>,
    /// SiliconFlow 模型名
    #[serde(default)]
    pub siliconflow_model: Option<String>,
    /// OpenAI API Key
    #[serde(default)]
    pub openai_key: Option<String>,
    /// OpenAI 兼容 base_url（默认官方；可指向任意 OpenAI 兼容网关）
    #[serde(default)]
    pub openai_base_url: Option<String>,
    /// OpenAI 模型名
    #[serde(default)]
    pub openai_model: Option<String>,
    /// Microsoft Translator (Edge/Azure) 订阅密钥
    #[serde(default)]
    pub edge_key: Option<String>,
    /// Microsoft Translator 区域（如 eastasia）
    #[serde(default)]
    pub edge_region: Option<String>,
    /// Bing 翻译（Azure）订阅密钥（与 Edge 可独立）
    #[serde(default)]
    pub bing_key: Option<String>,
    /// Bing 翻译区域
    #[serde(default)]
    pub bing_region: Option<String>,
}

impl Default for TranslateConfig {
    fn default() -> Self {
        Self {
            // 默认「免密钥优先」：开箱即用（MyMemory/Google 免密钥），本地 LLM 作为兜底
            fallback_order: vec!["mymemory".into(), "google".into(), "local-llm".into()],
            siliconflow_key: None,
            siliconflow_base_url: None,
            siliconflow_model: None,
            openai_key: None,
            openai_base_url: None,
            openai_model: None,
            edge_key: None,
            edge_region: None,
            bing_key: None,
            bing_region: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Config {
    /// PP-OCRv6 模型目录
    pub ocr_model_dir: Option<String>,
    /// 本地大模型端点（Ollama 默认端口）
    pub llm_endpoint: Option<String>,
    /// Ollama 模型名（默认 qwen2.5）
    pub llm_model: Option<String>,
    /// 全局动作热键表：动作 id（如 `fullscreen_translate`）→ 组合键（如 `Ctrl+Alt+O`）。
    /// 缺省回落 [`DEFAULT_HOTKEYS`]。旧配置的单 `hotkey` 字段在 [`load`] 时自动迁移到
    /// `region_translate`——该动作 2026-10-03 已随框选下线，迁移后会被热键线程安全忽略，
    /// 仅作为「用户曾配置过」的历史痕迹保留，不产生任何热键注册。
    #[serde(default)]
    pub hotkeys: HashMap<String, String>,
    /// 原生控制台 UI 主题（"dark" | "light"）
    pub ui_theme: Option<String>,
    /// 界面字体族 id（见前端 `FONT_FAMILIES`）。`None` = 用 tokens.css 默认。
    ///
    /// 存 id 而非字体栈：字体栈是实现细节且需 CSS 转义，放前端常量表里维护，
    /// 配置只负责「选了第几个」，后端不感知具体字体名。
    #[serde(default)]
    pub ui_font: Option<String>,
    /// 界面字号缩放百分比（80–160）。`None` = 100%。
    ///
    /// 用**缩放**而非逐档字号：tokens.css 里字号已成体系（xs/sm/md/base/lg/xl），
    /// 改一处 `--font-size-*` 的缩放基准即可整体等比变化，无需逐个改 6 个变量。
    #[serde(default)]
    pub ui_font_scale: Option<u16>,
    /// 主题色板 id（见前端 `ACCENTS`）。`None` = 用 tokens.css 默认蓝。
    #[serde(default)]
    pub ui_accent: Option<String>,
    /// Translate 轴配置（M7）。缺省时回落 [`TranslateConfig::default`]。
    #[serde(default)]
    pub translate: Option<TranslateConfig>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            ocr_model_dir: None,
            llm_endpoint: Some("http://127.0.0.1:11434".to_string()),
            llm_model: Some("qwen2.5".to_string()),
            hotkeys: HashMap::new(),
            ui_theme: Some("dark".to_string()),
            ui_font: None,
            ui_font_scale: None,
            ui_accent: None,
            translate: None,
        }
    }
}

/// 配置文件路径：%APPDATA%/FullSceneOCR/config.json（见 PRODUCTION.md §6）
pub fn config_path() -> Result<std::path::PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Config("无法解析系统配置目录".to_string()))?;
    let p = base.join("FullSceneOCR").join("config.json");
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    Ok(p)
}

pub fn load() -> Result<Config> {
    let p = config_path()?;
    if !p.exists() {
        return Ok(Config::default());
    }
    let s = std::fs::read_to_string(&p).map_err(AppError::Io)?;
    // 旧配置兼容：单 `hotkey` 字段 → `hotkeys.region_translate`，并清理遗留字段。
    let mut v: serde_json::Value = serde_json::from_str(&s)?;
    if let Some(obj) = v.as_object_mut() {
        if let Some(hk) = obj.get("hotkey").and_then(|x| x.as_str()) {
            if !obj.contains_key("hotkeys") {
                let mut m = serde_json::Map::new();
                m.insert("region_translate".into(), serde_json::Value::String(hk.to_string()));
                obj.insert("hotkeys".into(), serde_json::Value::Object(m));
            }
            obj.remove("hotkey");
        }
    }
    Ok(serde_json::from_value(v)?)
}

pub fn save(cfg: &Config) -> Result<()> {
    let p = config_path()?;
    let s = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&p, s).map_err(AppError::Io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_ui_theme_is_dark() {
        assert_eq!(Config::default().ui_theme.as_deref(), Some("dark"));
    }

    #[test]
    fn default_config_uses_ollama_endpoint() {
        // oracle: 未配置时默认指向本机 Ollama 11434，模型 qwen2.5，热键表为空（用代码内置默认）
        let cfg = Config::default();
        assert_eq!(cfg.llm_endpoint.as_deref(), Some("http://127.0.0.1:11434"));
        assert_eq!(cfg.llm_model.as_deref(), Some("qwen2.5"));
        assert!(cfg.hotkeys.is_empty());
        assert_eq!(cfg.ocr_model_dir, None);
        assert_eq!(cfg.translate, None);
    }

    #[test]
    fn json_round_trip_preserves_all_fields() {
        let cfg = Config {
            ocr_model_dir: Some("D:/models/ppocrv6".into()),
            llm_endpoint: Some("http://127.0.0.1:8080".into()),
            llm_model: Some("llama3".into()),
            hotkeys: {
                let mut m = HashMap::new();
                m.insert("region_translate".into(), "Ctrl+Shift+S".into());
                m
            },
            ui_theme: Some("light".into()),
            translate: Some(TranslateConfig {
                fallback_order: vec!["openai".into(), "edge".into()],
                siliconflow_key: Some("sk-sf".into()),
                ..Default::default()
            }),
        };
        let s = serde_json::to_string(&cfg).unwrap();
        assert_eq!(serde_json::from_str::<Config>(&s).unwrap(), cfg);
    }

    #[test]
    fn empty_object_yields_all_none() {
        // oracle: 配置文件为空对象时，全部字段为 None/空（不回落 Default）
        let cfg: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(
            cfg,
            Config {
                ocr_model_dir: None,
                llm_endpoint: None,
                llm_model: None,
                hotkeys: HashMap::new(),
                ui_theme: None,
                translate: None
            }
        );
    }

    #[test]
    fn partial_object_fills_only_given_fields() {
        // 脏输入：只给一个字段，其余应为 None 而非 panic 或回落默认值
        let cfg: Config = serde_json::from_str(r#"{"hotkeys":{"region_translate":"Alt+Z"}}"#).unwrap();
        assert_eq!(cfg.hotkeys.get("region_translate").map(String::as_str), Some("Alt+Z"));
        assert_eq!(cfg.llm_endpoint, None);
        assert_eq!(cfg.llm_model, None);
        assert_eq!(cfg.ocr_model_dir, None);
        assert_eq!(cfg.translate, None);
    }

    #[test]
    fn malformed_config_is_rejected() {
        // 脏输入：非法 JSON -> 必须报错，不能静默用默认值掩盖损坏的配置
        assert!(serde_json::from_str::<Config>("{oops").is_err());
    }

    #[test]
    fn settings_schema_matches_config_fields() {
        // 层内防漂移：settings.schema.json 的顶层属性集合必须与 Config 结构体的字段一致。
        // 新增/重命名配置项时，若只改一端忘改另一端，此测试失败（与 nm-protocol 同一思路）。
        let schema_text = include_str!("../settings.schema.json");
        let schema: serde_json::Value = serde_json::from_str(schema_text).expect("schema 必须是合法 JSON");
        let props = schema
            .get("properties")
            .and_then(|p| p.as_object())
            .expect("schema.properties 必须存在")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let canonical = [
            "ocr_model_dir",
            "llm_endpoint",
            "llm_model",
            "hotkeys",
            "ui_theme",
            "ui_font",
            "ui_font_scale",
            "ui_accent",
            "translate",
        ];
        let mut props_sorted = props;
        props_sorted.sort();
        let mut canon_sorted = canonical.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        canon_sorted.sort();
        assert_eq!(props_sorted, canon_sorted, "schema 属性集与 Config 字段不一致（漂移）");
        // additionalProperties:false 保证实例不会带未声明字段
        assert_eq!(schema.get("additionalProperties").and_then(|v| v.as_bool()), Some(false));
    }
}
