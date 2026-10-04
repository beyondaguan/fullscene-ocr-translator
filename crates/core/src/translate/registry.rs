//! 引擎注册表：保存所有已注册引擎，按降级链选主 + 失败回退。
//!
//! 参照 WinOCR 3.4 的 `Registry`：扫描实现、按规则选择、异常不崩（单次失败继续下一个）。

use crate::error::{AppError, Result};
use crate::translate::base::TranslateBase;

/// 翻译引擎注册表。
#[derive(Default)]
pub struct Registry {
    engines: Vec<Box<dyn TranslateBase>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册引擎；同 id 覆盖，避免重复构造导致重复项。
    pub fn register(&mut self, engine: Box<dyn TranslateBase>) {
        if let Some(pos) = self.engines.iter().position(|e| e.id() == engine.id()) {
            self.engines[pos] = engine;
        } else {
            self.engines.push(engine);
        }
    }

    /// 按 id 取引擎。
    pub fn get(&self, id: &str) -> Option<&dyn TranslateBase> {
        self.engines
            .iter()
            .find(|e| e.id() == id)
            .map(|b| b.as_ref())
    }

    /// 全部已注册引擎。
    pub fn list(&self) -> &[Box<dyn TranslateBase>] {
        &self.engines
    }

    /// 按降级链选第一个 available 的引擎。
    ///
    /// 链内按顺序**跳过**不可用者（缺密钥 / 模型未就绪）继续往后找。
    /// 若链内全不可用，返回 `None`（无可用引擎）由上层报错提示配置。
    ///
    /// **刻意不扫描注册表兜底**：那会绕过用户设定的排序意图，尤其会让离线兜底引擎
    /// `argos`（`available()` 只要语言包在位就为 true）在链外被抢先选中，
    /// 违反「在线优先、离线最后」的设计。
    pub fn select<'a>(&'a self, order: &[String]) -> Option<&'a dyn TranslateBase> {
        order.iter().find_map(|id| {
            self.get(id)
                .filter(|e| e.available())
        })
    }

    /// 把降级链里**当前首选的可用引擎**往后挪一位，返回新的首选引擎 id。
    ///
    /// 供 `cycle_engine` 全局热键使用。语义要点：
    /// - **只在可用引擎之间轮换**。缺密钥 / 未配置的引擎（`available()=false`）
    ///   永远不会被选为首选，否则按一次热键就可能落到一个注定失败的引擎上。
    /// - 不可用的引擎仍保留在链中，只是排在新首选之后——降级时照样能兜底。
    /// - 只有 0 或 1 个可用引擎时返回 `None`（无从切换）。
    ///
    /// 返回值是新的 `fallback_order`，调用方负责持久化。
    pub fn cycle_primary(&self, order: &[String]) -> Option<(String, Vec<String>)> {
        let available: Vec<String> = order
            .iter()
            .filter(|id| self.get(id).map(|e| e.available()).unwrap_or(false))
            .cloned()
            .collect();
        if available.len() < 2 {
            return None;
        }
        // 新顺序：第 2 个可用引擎提到最前，第 1 个紧随其后，其余保持原有相对顺序。
        // 被轮换的两个引擎在链中只保留一次：若历史数据里有重复项（如旧的切换
        // 逻辑不去重导致 local-llm/mymemory 出现两次），filter 一并清除。
        let next: Vec<String> = std::iter::once(available[1].clone())
            .chain(std::iter::once(available[0].clone()))
            .chain(
                order
                    .iter()
                    .filter(|id| *id != &available[0] && *id != &available[1])
                    .cloned(),
            )
            .collect();
        Some((available[1].clone(), next))
    }

    /// 依次尝试降级链中的引擎，返回首个成功且非空的译文。
    ///
    /// - 链内 unavailable 的引擎直接跳过（不网络请求）。
    /// - 链路为空或全部 unavailable → 明确错误，列出降级链。
    /// - 某个 available 引擎运行时失败 → 记录末次错误并尝试下一个。
    pub fn translate_with_fallback(
        &self,
        order: &[String],
        text: &str,
        src: &str,
        dst: &str,
    ) -> Result<String> {
        self.translate_with_fallback_detailed(order, text, src, dst)
            .map(|r| r.text)
    }

    /// 同 [`Self::translate_with_fallback`]，但额外回报**实际出译文的引擎**。
    ///
    /// 必要性：降级链会静默换引擎（首选项缺密钥/超时就落到下一个），
    /// 而原实现只返回译文字符串，把「谁翻译的」完全丢掉——状态栏因此
    /// 只能显示前端本地 state 里的名义引擎，与实际严重不符。
    pub fn translate_with_fallback_detailed(
        &self,
        order: &[String],
        text: &str,
        src: &str,
        dst: &str,
    ) -> Result<TranslationOutcome> {
        let candidates: Vec<&dyn TranslateBase> = order
            .iter()
            .filter_map(|id| self.get(id))
            .filter(|e| e.available())
            .collect();

        if candidates.is_empty() {
            return Err(AppError::Translate(format!(
                "降级链 [{}] 中无可用引擎（缺少密钥或未配置）",
                order.join(" → ")
            )));
        }

        // 收集**每个**引擎的失败原因：只留「末次错误」会掩盖真实原因——
        // 例如中文→中文时 MyMemory / Google 都是 403，末次却是未装 Ollama 的 10061，
        // 看着像网络问题，实际是源语言=目标语言。
        let mut errs: Vec<String> = Vec::new();
        for e in candidates {
            match translate_long(e, text, src, dst) {
                Ok(t) if !t.trim().is_empty() => {
                    return Ok(TranslationOutcome {
                        text: t,
                        engine: e.id().to_string(),
                        // 该引擎在**配置链**中的位置（1-based），用于状态栏
                        // 显示「第 2/4 环」；不在链中（理论上不会发生）则 None。
                        position: order.iter().position(|id| id == e.id()).map(|i| i + 1),
                        chain_len: order.len(),
                        tried: errs.len(),
                    });
                }
                Ok(_) => errs.push(format!("{} 返回空译文", e.id())),
                Err(err) => errs.push(format!("{}: {}", e.id(), err)),
            }
        }
        Err(AppError::Translate(format!("全部引擎失败（{}）", errs.join(" | "))))
    }
}

/// 一次降级链翻译的结果，含**实际服务该次翻译的引擎**。
#[derive(Debug, Clone)]
pub struct TranslationOutcome {
    /// 译文正文
    pub text: String,
    /// 实际出译文的引擎 id
    pub engine: String,
    /// 该引擎在配置降级链中的位置（1-based）；不在链中则 None
    pub position: Option<usize>,
    /// 配置降级链总长度
    pub chain_len: usize,
    /// 本次之前有多少个引擎尝试失败
    pub tried: usize,
}

/// 按引擎上限分片翻译，再按原顺序拼接。
///
/// 必要性：整屏 OCR 原文动辄上千字符，而免密钥引擎（MyMemory）实测硬上限 500 字符——
/// 不分片则整屏翻译**永远**拿不到译文（要么报错串，要么降级到不可用引擎空转几十秒）。
///
/// 任一片失败即整引擎失败（交给降级链的下一个引擎）：半截译文比报错更难排查。
fn translate_long(
    e: &dyn TranslateBase,
    text: &str,
    src: &str,
    dst: &str,
) -> Result<String> {
    let chunks = split_for_translation(text, e.max_chars());
    if chunks.len() <= 1 {
        return e.translate(text, src, dst);
    }
    let mut out = String::new();
    for (i, c) in chunks.iter().enumerate() {
        let t = e.translate(c, src, dst)?;
        if i > 0 {
            out.push('\n');
        }
        out.push_str(t.trim());
    }
    Ok(out)
}

/// 把长文本切成若干 ≤ `max_chars` 字符的片。
///
/// 规则（先按行、再按字符硬切）：
/// - 优先在 `\n` 处分片——OCR 每行是一条独立文本框，语义边界天然就在行尾；
/// - 单行本身超限才按字符硬切，避免「一行 3000 字」时退化成整段不切；
/// - 不产出空白片，避免给引擎发无意义请求。
pub(crate) fn split_for_translation(text: &str, max_chars: usize) -> Vec<String> {
    let max = max_chars.max(1);
    if text.chars().count() <= max {
        return vec![text.to_string()];
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in text.split('\n') {
        if line.chars().count() > max {
            // 单行超限：先冲刷已累积内容，再按字符硬切该行
            if !cur.is_empty() {
                chunks.push(std::mem::take(&mut cur));
            }
            let mut buf = String::new();
            for c in line.chars() {
                buf.push(c);
                if buf.chars().count() >= max {
                    chunks.push(std::mem::take(&mut buf));
                }
            }
            if !buf.is_empty() {
                chunks.push(buf);
            }
            continue;
        }
        // 加上这一行会超限 → 先封口当前片
        if !cur.is_empty() && cur.chars().count() + 1 + line.chars().count() > max {
            chunks.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(line);
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Result as CoreResult;
    use std::sync::{Arc, Mutex};

    #[test]
    fn split_keeps_short_text_as_single_chunk() {
        let c = split_for_translation("hello", 450);
        assert_eq!(c, vec!["hello".to_string()]);
    }

    #[test]
    fn split_respects_line_boundaries() {
        // 每行 5 字符，上限 12 → 每 2 行一片（5+1+5=11 ≤ 12）
        let text = "aaaaa\nbbbbb\nccccc\nddddd";
        let c = split_for_translation(text, 12);
        assert_eq!(c, vec!["aaaaa\nbbbbb".to_string(), "ccccc\nddddd".to_string()]);
    }

    #[test]
    fn split_hard_cuts_a_single_oversized_line() {
        let c = split_for_translation("0123456789", 4);
        assert_eq!(c, vec!["0123".to_string(), "4567".to_string(), "89".to_string()]);
    }

    #[test]
    fn split_never_emits_empty_chunks() {
        let c = split_for_translation("a\n\n\nb", 450);
        assert_eq!(c, vec!["a\n\n\nb".to_string()]);
        for chunk in split_for_translation("aaaaaaaaaa\n\nbbbbbbbbbb", 12) {
            assert!(!chunk.trim().is_empty());
        }
    }

    #[test]
    fn split_covers_whole_text_without_data_loss() {
        let text: String = (0..200).map(|i| format!("line{i}\n")).collect();
        let c = split_for_translation(&text, 100);
        let joined = c.join("\n");
        // 逐行重建后必须能还原全部内容（分片只切分，不丢字符）
        let rebuilt: Vec<&str> = joined.split('\n').filter(|s| !s.is_empty()).collect();
        assert_eq!(rebuilt.len(), 200);
    }

    /// 记录每次收到的分片长度，验证「长文被拆成多片且每片不超上限」。
    struct RecordingEngine {
        limit: usize,
        seen: Arc<Mutex<Vec<usize>>>,
    }

    impl TranslateBase for RecordingEngine {
        fn id(&self) -> &'static str {
            "rec"
        }
        fn label(&self) -> &'static str {
            "rec"
        }
        fn available(&self) -> bool {
            true
        }
        fn max_chars(&self) -> usize {
            self.limit
        }
        fn translate(&self, text: &str, _s: &str, _d: &str) -> CoreResult<String> {
            self.seen.lock().unwrap().push(text.chars().count());
            Ok(format!("<{}>", text.chars().count()))
        }
    }

    #[test]
    fn fallback_splits_long_text_per_engine_limit() {
        let mut r = Registry::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        r.register(Box::new(RecordingEngine { limit: 10, seen: Arc::clone(&seen) }));
        let text = "aaaaaaaaa\nbbbbbbbbb\nccccccccc"; // 29 字符，上限 10
        let out = r.translate_with_fallback(&["rec".into()], text, "auto", "zh").unwrap();
        let lens = seen.lock().unwrap().clone();
        assert!(lens.len() > 1, "长文必须被分片，实际 {lens:?}");
        assert!(lens.iter().all(|n| *n <= 10), "每片不得超过上限，实际 {lens:?}");
        assert_eq!(out.matches('<').count(), lens.len(), "每片译文都要拼进结果");
    }

    #[test]
    fn fallback_does_not_split_short_text() {
        let mut r = Registry::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        r.register(Box::new(RecordingEngine { limit: 450, seen: Arc::clone(&seen) }));
        r.translate_with_fallback(&["rec".into()], "hi", "auto", "zh").unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1, "短文本不应分片");
    }

    /// 可用性可控的引擎：用于验证「按链顺序选、绝不链外兜底」。
    struct ToggleEngine {
        id: &'static str,
        is_available: bool,
    }

    impl TranslateBase for ToggleEngine {
        fn id(&self) -> &'static str {
            self.id
        }
        fn label(&self) -> &'static str {
            self.id
        }
        fn available(&self) -> bool {
            self.is_available
        }
        fn translate(&self, text: &str, _s: &str, _d: &str) -> CoreResult<String> {
            Ok(text.to_string())
        }
    }

    #[test]
    fn select_respects_chain_order() {
        // oracle: 链内命中即返回，且取链上第一个 available 的
        let mut r = Registry::new();
        r.register(Box::new(ToggleEngine { id: "a", is_available: false }));
        r.register(Box::new(ToggleEngine { id: "b", is_available: true }));
        r.register(Box::new(ToggleEngine { id: "c", is_available: true }));
        let order = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert_eq!(r.select(&order).map(|e| e.id()), Some("b"));
    }

    #[test]
    fn select_does_not_fall_back_outside_chain() {
        // 回归：曾有「链内全不可用 → 扫描注册表任意可用引擎」的兜底，会让离线引擎
        // argos（available 只要语言包在位即为 true）在链外被抢先选中，
        // 违反「在线优先、离线最后」。现在必须返回 None（无可用引擎）。
        let mut r = Registry::new();
        r.register(Box::new(ToggleEngine { id: "offline", is_available: false }));
        r.register(Box::new(ToggleEngine { id: "chain-ok", is_available: true }));
        // 链里只有不可用的 offline；chain-ok 在链外
        let order = vec!["offline".to_string()];
        assert_eq!(r.select(&order).map(|e| e.id()), None, "链外引擎不得被选中");
    }

    #[test]
    fn fallback_errors_when_all_chain_entries_unavailable() {
        // oracle: 链内全不可用 → 明确报错，绝不静默改用链外引擎
        let mut r = Registry::new();
        r.register(Box::new(ToggleEngine { id: "offline", is_available: false }));
        r.register(Box::new(ToggleEngine { id: "chain-ok", is_available: true }));
        let err = r
            .translate_with_fallback(&["offline".to_string()], "hi", "auto", "zh")
            .unwrap_err();
        assert!(err.to_string().contains("无可用引擎"), "实际 {err}");
    }

    #[test]
    fn cycle_primary_moves_to_next_available_without_duplicates() {
        let mut r = Registry::new();
        r.register(Box::new(ToggleEngine { id: "a", is_available: true }));
        r.register(Box::new(ToggleEngine { id: "b", is_available: true }));
        r.register(Box::new(ToggleEngine { id: "c", is_available: true }));
        let order = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let (new_primary, next) = r.cycle_primary(&order).unwrap();
        assert_eq!(new_primary, "b", "新首选应是第 2 个可用引擎");
        assert_eq!(next, vec!["b".to_string(), "a".to_string(), "c".to_string()], "轮换后不应产生重复项");
    }

    #[test]
    fn cycle_primary_dedups_historical_duplicates() {
        // 回归：旧实现只把 available[0] 挪到 available[1] 之后但不去重，
        // 多次切换后链内出现 local-llm/mymemory 各两份。修复后必须清理历史重复项。
        let mut r = Registry::new();
        r.register(Box::new(ToggleEngine { id: "a", is_available: true }));
        r.register(Box::new(ToggleEngine { id: "b", is_available: true }));
        r.register(Box::new(ToggleEngine { id: "c", is_available: true }));
        let order = vec![
            "a".to_string(),
            "b".to_string(),
            "a".to_string(),
            "c".to_string(),
            "b".to_string(),
        ];
        let (new_primary, next) = r.cycle_primary(&order).unwrap();
        assert_eq!(new_primary, "b");
        assert_eq!(
            next,
            vec!["b".to_string(), "a".to_string(), "c".to_string()],
            "被轮换的两个引擎只保留一次，历史重复项应被清除"
        );
    }

    #[test]
    fn cycle_primary_requires_two_available() {
        let mut r = Registry::new();
        r.register(Box::new(ToggleEngine { id: "a", is_available: true }));
        r.register(Box::new(ToggleEngine { id: "off", is_available: false }));
        let order = vec!["a".to_string(), "off".to_string()];
        assert!(r.cycle_primary(&order).is_none(), "可用引擎不足 2 个时不应切换");
    }
}
