//! 极简语言判别（只服务一个目的：避免「中文原文 → 中文译文」的无意义请求）。

/// 判断文本是否主要由 CJK 汉字构成。
///
/// 用途：整屏/框选 OCR 常常截到**已经是中文**的内容（本工具的界面、中文网页、中文文档）。
/// 此时再发翻译请求，MyMemory / Google 会直接返回
/// `PLEASE SELECT TWO DISTINCT LANGUAGES`（403，源语言与目标语言相同），
/// 降级链一路失败、最后落到未安装的本地 LLM，用户看到「翻译失败」。
/// 正确行为是：原文已是目标语言 → 直接回填原文，不再请求引擎。
///
/// 判据：汉字数 ≥ 非空字符数的 **1/3** 即视为「主要中文」。
///
/// 阈值刻意定得低：OCR 一屏常常是中英混杂（界面里的 English 单词 + 中文正文），
/// 而 MyMemory 只要把源语言判成 zh-CN、目标又是 zh，就返回 `translatedText: null`。
/// 宁可多短路一次（少一次翻译），也不要把整段送去撞「源=目标」的空响应。
pub fn is_mostly_cjk(text: &str) -> bool {
    let meaningful = text.chars().filter(|c| !c.is_whitespace()).count();
    if meaningful == 0 {
        return false;
    }
    let cjk = text
        .chars()
        .filter(|c| ('\u{4E00}'..='\u{9FFF}').contains(c))
        .count();
    cjk * 3 >= meaningful
}

/// 目标语言是否中文（`zh` / `zh-CN` / `zh-Hans` …）。
pub fn is_chinese_target(dst: &str) -> bool {
    dst.to_ascii_lowercase().starts_with("zh")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_text_is_mostly_cjk() {
        assert!(is_mostly_cjk("前列腺癌筛查应当与患者充分沟通后再决定"));
    }

    #[test]
    fn english_text_is_not_mostly_cjk() {
        assert!(!is_mostly_cjk("Prostate cancer screening should be discussed"));
    }

    #[test]
    fn mixed_text_threshold_is_one_third() {
        // 阈值是 1/3：汉字 2 / 非空 5 → 2*3=6 ≥ 5，算中文
        assert!(is_mostly_cjk("中文 abc"));
        // 汉字 2 / 非空 9 → 6 < 9，不算中文（英文为主，该真翻译）
        assert!(!is_mostly_cjk("English 中文 words"));
        assert!(is_mostly_cjk("中文 汉字字"));
    }

    /// 回归：真机 OCR 出的中英混杂文本必须被判为中文，否则会撞 MyMemory 的
    /// 「源=目标 → translatedText: null」空响应。
    #[test]
    fn real_ocr_mixed_text_is_treated_as_chinese() {
        let ocr = "嗯...无法访问此页面 patient. 请尝试：检查连接 检查代理和防火墙";
        assert!(is_mostly_cjk(ocr));
    }

    #[test]
    fn empty_or_blank_is_not_cjk() {
        assert!(!is_mostly_cjk(""));
        assert!(!is_mostly_cjk("   \n\t"));
    }

    #[test]
    fn chinese_target_detection() {
        assert!(is_chinese_target("zh"));
        assert!(is_chinese_target("zh-CN"));
        assert!(is_chinese_target("ZH-Hans"));
        assert!(!is_chinese_target("en"));
    }
}
