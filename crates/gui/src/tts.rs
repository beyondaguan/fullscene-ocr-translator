//! TTS 适配层（阶段 B3）：OneCore 优先 + SAPI5 兜底。
//!
//! 设计见 `docs/划词取词设计.md` §5：
//!
//! - **OneCore**（`Windows.Media.SpeechSynthesis`）：音质自然，但需要 Windows 语音 FoD。
//!   本机 Win10 Home 无 FoD → `AllVoices()` 为空 → `available()=false`，自动不上线。
//!   代码先写好，将来装了 FoD / 换机即自动生效。
//! - **SAPI5**（`SpVoice` + `ISpVoice`）：本机实测可用（Huihui / Zira 各 1），
//!   是当前实际生效的通道。
//!
//! 语音选择规则（设计 §5.3）：按**待朗读文本**的语言挑语音，`zh-*` → Huihui，
//! 其余 → Zira；无匹配则用默认语音。两者都不可用时，由调用方隐藏「朗读」按钮。
//!
//! # 线程模型
//!
//! SAPI5 的 `ISpVoice` 与 OneCore 的 `SpeechSynthesizer` 都是 COM 对象，绑定创建线程的
//! COM 单元。因此每次 `speak()` 都在**调用方线程**上现建对象（`CoInitializeEx` →
//! 使用 → `CoUninitialize`），不跨线程共享 COM 指针。`TtsEngine` 本身只保存
//! 枚举出的语音元数据（`VoiceInfo`），是纯数据，可安全 `Send + Sync`。

use windows::core::{HSTRING, PCWSTR};
use windows::Media::SpeechSynthesis::SpeechSynthesizer;
use windows::Storage::Streams::{Buffer, DataReader, InputStreamOptions};
use windows::Win32::Media::Audio::{PlaySoundW, SND_MEMORY, SND_NODEFAULT, SND_SYNC};
use windows::Win32::Media::Speech::{
    ISpObjectToken, ISpObjectTokenCategory, ISpVoice, SpObjectTokenCategory, SpVoice, SPCAT_VOICES,
    SPF_ASYNC, SPF_PURGEBEFORESPEAK,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

/// 一条语音信息（供 UI 展示 / 语音选择）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceInfo {
    /// 语音唯一 id（SAPI5 为 token 名，OneCore 为 VoiceInformation.Id）。
    pub id: String,
    /// 展示名（如 "Microsoft Huihui Desktop"）。
    pub name: String,
    /// 语言标签（如 "zh-CN" / "en-US"）。
    pub lang: String,
}

/// TTS 朗读参数。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TtsOptions {
    /// 语速倍率（1.0 = 正常）。
    pub rate: f64,
    /// 音量（0.0 ~ 1.0）。
    pub volume: f64,
}

impl Default for TtsOptions {
    fn default() -> Self {
        Self {
            rate: 1.0,
            volume: 1.0,
        }
    }
}

/// TTS 引擎抽象。
///
/// 实现必须是 `Send + Sync`：`speak()` 会被放到独立线程执行（浮窗消息循环不能阻塞）。
pub trait TtsEngine: Send + Sync {
    /// 引擎名（日志 / 诊断用）。
    fn name(&self) -> &'static str;
    /// 是否可用（有可用语音）。不可用的引擎不会被注册进 [`TtsRegistry`]。
    fn available(&self) -> bool;
    /// 全部可用语音。
    fn voices(&self) -> Vec<VoiceInfo>;
    /// 朗读文本。失败返回错误串（调用方可据此尝试下一个引擎）。
    fn speak(&self, text: &str, opts: &TtsOptions) -> Result<(), String>;
}

/// TTS 注册表：OneCore 优先，SAPI5 兜底。
///
/// 构造时依次探测 OneCore / SAPI5，只保留 `available()` 的引擎。
/// 两者都不可用 → `has_any()=false`，调用方应隐藏「朗读」按钮。
pub struct TtsRegistry {
    engines: Vec<Box<dyn TtsEngine>>,
}

impl TtsRegistry {
    /// 探测并构造注册表。
    pub fn new() -> Self {
        let mut engines: Vec<Box<dyn TtsEngine>> = Vec::new();
        // OneCore 优先：本机无 FoD 时 AllVoices() 为空，自动落 SAPI5。
        match OneCoreEngine::new() {
            Ok(e) if e.available() => {
                crate::log::line(&format!(
                    "tts: {} 可用（{} 个语音）",
                    e.name(),
                    e.voices().len()
                ));
                engines.push(Box::new(e));
            }
            Ok(e) => crate::log::line(&format!(
                "tts: {} 无语音（{} 个），落 SAPI5",
                e.name(),
                e.voices().len()
            )),
            Err(err) => crate::log::line(&format!("tts: OneCore 初始化失败，落 SAPI5: {err}")),
        }
        match Sapi5Engine::new() {
            Ok(e) if e.available() => {
                crate::log::line(&format!(
                    "tts: {} 可用（{} 个语音）",
                    e.name(),
                    e.voices().len()
                ));
                engines.push(Box::new(e));
            }
            Ok(e) => crate::log::line(&format!(
                "tts: {} 无语音（{} 个），朗读按钮将隐藏",
                e.name(),
                e.voices().len()
            )),
            Err(err) => crate::log::line(&format!("tts: SAPI5 初始化失败: {err}")),
        }
        Self { engines }
    }

    /// 是否有任何可用 TTS 引擎（false → UI 隐藏朗读按钮）。
    pub fn has_any(&self) -> bool {
        !self.engines.is_empty()
    }

    /// 朗读文本：按注册顺序尝试，全部失败才返回错误。
    pub fn speak(&self, text: &str, opts: &TtsOptions) -> Result<(), String> {
        let mut last_err = "没有可用的 TTS 引擎".to_string();
        for e in &self.engines {
            match e.speak(text, opts) {
                Ok(()) => return Ok(()),
                Err(err) => last_err = err,
            }
        }
        Err(last_err)
    }
}

impl Default for TtsRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// SAPI5 引擎（当前实际生效通道）
// ---------------------------------------------------------------------------

/// SAPI5 引擎：`CoCreateInstance(SpVoice)` + `ISpVoice::Speak`。
///
/// 语音枚举走 `ISpObjectTokenCategory(SpObjectTokenCategory)` + `EnumTokens`，
/// 每个 token 用 `ISpObjectToken::GetStringValue("Name"/"Language")` 读元数据。
pub struct Sapi5Engine {
    voices: Vec<VoiceInfo>,
}

impl Sapi5Engine {
    /// 探测并枚举 SAPI5 语音。
    pub fn new() -> Result<Self, String> {
        let voices = unsafe { enumerate_sapi_voices()? };
        Ok(Self { voices })
    }

    /// 按文本语言选择语音：中文 → 首个 zh 语音（Huihui），否则 → 首个 en 语音（Zira）。
    fn select_voice<'a>(&'a self, text: &str) -> Option<&'a VoiceInfo> {
        let want_zh = text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
        if want_zh {
            self.voices
                .iter()
                .find(|v| v.lang.to_ascii_lowercase().starts_with("zh"))
                .or_else(|| self.voices.first())
        } else {
            self.voices
                .iter()
                .find(|v| v.lang.to_ascii_lowercase().starts_with("en"))
                .or_else(|| self.voices.first())
        }
    }
}

impl TtsEngine for Sapi5Engine {
    fn name(&self) -> &'static str {
        "sapi5"
    }

    fn available(&self) -> bool {
        !self.voices.is_empty()
    }

    fn voices(&self) -> Vec<VoiceInfo> {
        self.voices.clone()
    }

    fn speak(&self, text: &str, opts: &TtsOptions) -> Result<(), String> {
        unsafe {
            // COM 单元：每次在调用线程初始化，结束时反初始化。
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            let need_uninit = hr.0 == 0;
            let result = (|| {
                let voice: ISpVoice = CoCreateInstance(&SpVoice, None, CLSCTX_ALL)
                    .map_err(|e| format!("创建 SpVoice 失败: {e}"))?;

                // 语速：SAPI5 SetRate 范围 -10..10，0 为正常速。
                let rate = (opts.rate - 1.0)
                    .mul_add(10.0, 0.0)
                    .round()
                    .clamp(-10.0, 10.0) as i32;
                voice.SetRate(rate).map_err(|e| format!("设置语速失败: {e}"))?;

                // 音量：SAPI5 SetVolume 范围 0..100。
                let volume = (opts.volume.clamp(0.0, 1.0) * 100.0).round() as u16;
                voice
                    .SetVolume(volume)
                    .map_err(|e| format!("设置音量失败: {e}"))?;

                // 按文本语言选语音（zh → Huihui，en → Zira）。
                if let Some(v) = self.select_voice(text) {
                    if let Some(token) = find_sapi_token_by_id(&v.id) {
                        let _ = voice.SetVoice(&token);
                    }
                }

                let wide: Vec<u16> = text.encode_utf16().collect();
                let flags = (SPF_ASYNC.0 | SPF_PURGEBEFORESPEAK.0) as u32;
                voice
                    .Speak(PCWSTR(wide.as_ptr()), flags, None)
                    .map_err(|e| format!("朗读失败: {e}"))?;
                // SPF_ASYNC 后阻塞等待读完，保证 `speak()` 返回时朗读已完成
                // （调用方在独立线程，阻塞不影响浮窗消息循环）。
                voice
                    .WaitUntilDone(u32::MAX)
                    .map_err(|e| format!("等待朗读完成失败: {e}"))?;
                Ok(())
            })();
            if need_uninit {
                CoUninitialize();
            }
            result
        }
    }
}

/// 在当前线程初始化 COM 并枚举全部 SAPI5 语音。
unsafe fn enumerate_sapi_voices() -> Result<Vec<VoiceInfo>, String> {
    let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
    let need_uninit = hr.0 == 0;
    let result = (|| {
        let category: ISpObjectTokenCategory =
            CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL)
                .map_err(|e| format!("创建语音类别失败: {e}"))?;
        // SPCAT_VOICES 指向注册表 Voices 键；第二个参数 false = 不创建。
        category
            .SetId(SPCAT_VOICES, false)
            .map_err(|e| format!("绑定语音类别失败: {e}"))?;
        let enumerator = category
            .EnumTokens(None, None)
            .map_err(|e| format!("枚举语音失败: {e}"))?;
        let mut count: u32 = 0;
        enumerator
            .GetCount(&mut count)
            .map_err(|e| format!("读取语音数量失败: {e}"))?;
        let mut voices = Vec::with_capacity(count as usize);
        for i in 0..count {
            let token = enumerator
                .Item(i)
                .map_err(|e| format!("读取第 {i} 个语音失败: {e}"))?;
            voices.push(token_to_voice(&token));
        }
        Ok(voices)
    })();
    if need_uninit {
        CoUninitialize();
    }
    result
}

/// 读取一个语音 token 的元数据。
unsafe fn token_to_voice(token: &ISpObjectToken) -> VoiceInfo {
    let name = read_token_string(token, "Name");
    let lang = read_token_string(token, "Language");
    VoiceInfo {
        id: name.clone(),
        name,
        lang,
    }
}

/// 读 token 的字符串值，用后立即释放 COM 内存。
unsafe fn read_token_string(token: &ISpObjectToken, value_name: &str) -> String {
    let name_wide: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();
    let ptr = match token.GetStringValue(PCWSTR(name_wide.as_ptr())) {
        Ok(p) => p,
        Err(_) => return String::new(),
    };
    if ptr.is_null() {
        return String::new();
    }
    let s = ptr_to_string(ptr);
    CoTaskMemFree(Some(ptr.as_ptr() as *const core::ffi::c_void));
    s
}

/// 把 `PWSTR`（以 0 结尾的 COM 字符串）转成 `String`。
unsafe fn ptr_to_string(ptr: windows::core::PWSTR) -> String {
    if ptr.is_null() {
        return String::new();
    }
    String::from_utf16_lossy(ptr.as_wide())
}

/// 按语音 id 在 SAPI5 语音类别中查找 token。
unsafe fn find_sapi_token_by_id(id: &str) -> Option<ISpObjectToken> {
    let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
    let need_uninit = hr.0 == 0;
    let result = (|| {
        let category: ISpObjectTokenCategory =
            CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL).ok()?;
        category.SetId(SPCAT_VOICES, false).ok()?;
        let enumerator = category.EnumTokens(None, None).ok()?;
        let mut count: u32 = 0;
        enumerator.GetCount(&mut count).ok()?;
        for i in 0..count {
            let token = enumerator.Item(i).ok()?;
            let name = read_token_string(&token, "Name");
            if name == id {
                return Some(token);
            }
        }
        None
    })();
    if need_uninit {
        CoUninitialize();
    }
    result
}

// ---------------------------------------------------------------------------
// OneCore 引擎（优先，本机无 FoD 时不可用）
// ---------------------------------------------------------------------------

/// OneCore 引擎：`Windows.Media.SpeechSynthesis.SpeechSynthesizer`。
///
/// 需要 Windows 语音 FoD；本机 Win10 Home 无 FoD → `AllVoices()` 为空 → `available()=false`。
pub struct OneCoreEngine {
    voices: Vec<VoiceInfo>,
}

impl OneCoreEngine {
    /// 探测并枚举 OneCore 语音。
    pub fn new() -> Result<Self, String> {
        let voices = enumerate_onecore_voices()?;
        Ok(Self { voices })
    }

    /// 按文本语言选择语音（逻辑同 SAPI5）。
    fn select_voice<'a>(&'a self, text: &str) -> Option<&'a VoiceInfo> {
        let want_zh = text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
        if want_zh {
            self.voices
                .iter()
                .find(|v| v.lang.to_ascii_lowercase().starts_with("zh"))
                .or_else(|| self.voices.first())
        } else {
            self.voices
                .iter()
                .find(|v| v.lang.to_ascii_lowercase().starts_with("en"))
                .or_else(|| self.voices.first())
        }
    }
}

impl TtsEngine for OneCoreEngine {
    fn name(&self) -> &'static str {
        "onecore"
    }

    fn available(&self) -> bool {
        !self.voices.is_empty()
    }

    fn voices(&self) -> Vec<VoiceInfo> {
        self.voices.clone()
    }

    fn speak(&self, text: &str, opts: &TtsOptions) -> Result<(), String> {
        unsafe {
            let synth = SpeechSynthesizer::new()
                .map_err(|e| format!("创建 SpeechSynthesizer 失败: {e}"))?;

            // 按文本语言选语音。
            if let Some(v) = self.select_voice(text) {
                let all = SpeechSynthesizer::AllVoices()
                    .map_err(|e| format!("枚举 OneCore 语音失败: {e}"))?;
                let size = all.Size().map_err(|e| e.to_string())?;
                for i in 0..size {
                    let vi = all.GetAt(i).map_err(|e| e.to_string())?;
                    if vi.Id().map_err(|e| e.to_string())?.to_string_lossy() == v.id {
                        synth.SetVoice(&vi)
                            .map_err(|e| format!("设置语音失败: {e}"))?;
                        break;
                    }
                }
            }

            // 语速 / 音量（OneCore 均为 0.0~1.0 之外的倍率/百分比，见设计 §5.2）。
            let options = synth
                .Options()
                .map_err(|e| format!("获取 TTS 选项失败: {e}"))?;
            options
                .SetSpeakingRate(opts.rate.clamp(0.5, 6.0))
                .map_err(|e| format!("设置语速失败: {e}"))?;
            options
                .SetAudioVolume((opts.volume.clamp(0.0, 1.0) * 100.0).round())
                .map_err(|e| format!("设置音量失败: {e}"))?;

            // 合成到流。
            let h = HSTRING::from(text);
            let op = synth
                .SynthesizeTextToStreamAsync(&h)
                .map_err(|e| format!("合成语音失败: {e}"))?;
            let stream = op.get().map_err(|e| format!("等待合成失败: {e}"))?;

            // 读取音频字节（WAV）。
            let input = stream
                .GetInputStreamAt(0)
                .map_err(|e| format!("读取音频流失败: {e}"))?;
            let bytes = read_stream_to_bytes(&input)?;
            if bytes.is_empty() {
                return Err("合成的音频为空".into());
            }

            // 内存播放。SND_MEMORY + SND_SYNC：bytes 在调用期间保持有效，返回即播完。
            let played = PlaySoundW(
                PCWSTR(bytes.as_ptr() as *const u16),
                None,
                SND_MEMORY | SND_SYNC | SND_NODEFAULT,
            );
            if !played.as_bool() {
                return Err("播放音频失败".into());
            }
            Ok(())
        }
    }
}

/// 枚举 OneCore 全部语音。
fn enumerate_onecore_voices() -> Result<Vec<VoiceInfo>, String> {
    let all = SpeechSynthesizer::AllVoices()
        .map_err(|e| format!("枚举 OneCore 语音失败: {e}"))?;
    let size = all.Size().map_err(|e| e.to_string())?;
    let mut voices = Vec::with_capacity(size as usize);
    for i in 0..size {
        let vi = all.GetAt(i).map_err(|e| e.to_string())?;
        let id = vi
            .Id()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let name = vi
            .DisplayName()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let lang = vi
            .Language()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        voices.push(VoiceInfo { id, name, lang });
    }
    Ok(voices)
}

/// 从 `IInputStream` 循环读出全部字节。
unsafe fn read_stream_to_bytes(
    input: &windows::Storage::Streams::IInputStream,
) -> Result<Vec<u8>, String> {
    let capacity = 8192u32;
    let mut out = Vec::new();
    loop {
        let buffer = Buffer::Create(capacity).map_err(|e| e.to_string())?;
        let op = input
            .ReadAsync(&buffer, capacity, InputStreamOptions(0))
            .map_err(|e| format!("读取音频流失败: {e}"))?;
        let read = op.get().map_err(|e| format!("等待读取失败: {e}"))?;
        let len = read.Length().map_err(|e| e.to_string())?;
        if len == 0 {
            break;
        }
        let mut tmp = vec![0u8; len as usize];
        let reader = DataReader::FromBuffer(&read).map_err(|e| e.to_string())?;
        reader
            .ReadBytes(&mut tmp)
            .map_err(|e| format!("读取音频数据失败: {e}"))?;
        out.extend_from_slice(&tmp);
        if len < capacity {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tts_options_defaults() {
        let o = TtsOptions::default();
        assert_eq!(o.rate, 1.0);
        assert_eq!(o.volume, 1.0);
    }

    #[test]
    fn tts_registry_with_no_engines_has_no_voice() {
        let r = TtsRegistry { engines: Vec::new() };
        assert!(!r.has_any());
        assert!(r.speak("hello", &TtsOptions::default()).is_err());
    }

    #[test]
    fn voice_info_is_clone_eq() {
        let a = VoiceInfo {
            id: "x".into(),
            name: "X".into(),
            lang: "en-US".into(),
        };
        let b = a.clone();
        assert_eq!(a, b);
    }
}