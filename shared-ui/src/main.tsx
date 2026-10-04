import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell, type WorkspaceMode, type DrawerKey, type DrawerSpec } from './layouts/AppShell';
import { Workspace, ENGINES } from './layouts/Workspace';
import { Chat, type ChatMessage } from './layouts/Chat';
import { History, type HistoryItem } from './layouts/History';
import { Settings, type SettingsData } from './layouts/Settings';
import { useTheme } from './hooks/useTheme';
import { createNativeMsgApi, type EngineInfo, type NativeMsgApi, type PipelineSnapshot } from './hooks/useNativeMsg';
import { StatusDot } from './components/StatusBar';
import type { SelectOption } from './components/Select';
import { countChars } from './utils/text';
import './tokens.css';
import './global.css';

/**
 * 主动拉取最近一次管线结果并回填两个文本区。
 *
 * 事件 `translation-ready` 是单向推送，桥未就绪/窗口重建时会永久丢失
 * （真机症状：日志显示翻译成功，界面却是 0 字）。本函数走 `get_result`
 * 命令读 Rust 侧权威状态，是不依赖事件送达的兜底。
 */
async function pullResult(
  api: NativeMsgApi,
  setSource: (v: string) => void,
  setTranslation: (v: string) => void,
  setLastRun?: (v: PipelineSnapshot) => void,
): Promise<void> {
  try {
    const r = await api.getResult();
    if (!r) return;
    // 只在确有内容时覆盖，避免把界面上用户手动编辑的文字清空。
    if (r.source) setSource(r.source);
    if (r.translation) setTranslation(r.translation);
    if (setLastRun && r.updated_at_ms > 0) setLastRun(r);
  } catch {
    // 桥未就绪时静默失败：这是兜底路径，主路径仍是事件。
  }
}

function getCurrentLabel(): string {
  // 选区窗口由 Rust 以 `index.html#selection` 打开：hash 是最可靠的身份标识
  //（不依赖 __TAURI__ 全局注入的时序）。
  if (typeof window !== 'undefined' && window.location.hash.includes('selection')) {
    return 'selection';
  }
  // 兜底：主窗体走 __TAURI__ 的 label（若可用）。
  const tauri = (window as unknown as { __TAURI__?: any }).__TAURI__;
  if (!tauri) return 'main';
  const wv = tauri.webviewWindow?.getCurrent?.() ?? tauri.getCurrentWebviewWindow?.();
  const l = wv?.label;
  return typeof l === 'function' ? l() : (l ?? 'main');
}

function Root() {
  // 必须 memo：createNativeMsgApi() 每次调用都返回**新对象**，若不固定引用，
  // 下面所有以 `api` 为依赖的 useEffect / useCallback 都会在每次渲染后失效重跑，
  // 表现为「初始化请求风暴 + 按钮点击后界面卡顿无响应」。
  const api = React.useMemo(() => createNativeMsgApi(), []);

  // 单画布状态（不再有多页路由，所有内容都在这一个画布上）
  const [mode, setMode] = React.useState<WorkspaceMode>('screenshot');
  const [activeDrawer, setActiveDrawer] = React.useState<DrawerKey | null>(null);

  // 当前窗口 label：'selection' = 截图选区浮层；其余 = 主窗体工作界面
  const [label] = React.useState(getCurrentLabel);

  const [source, setSource] = React.useState('');
  const [translation, setTranslation] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);

  const [srcLang, setSrcLang] = React.useState('auto');
  const [dstLang, setDstLang] = React.useState('zh');
  const [ocrReady, setOcrReady] = React.useState(false);
  const [config, setConfig] = React.useState<SettingsData>({});
  // ★ engine 必须与 config.translate.fallback_order[0] 同步，而非写死初值。
  //    首次从配置恢复（否则刷新后回到 local-llm 造成与状态栏不同步），
  //    并在 config 变更（热键切换引擎、重载配置）时跟随更新。
  const [engine, setEngine] = React.useState(() => {
    // 尝试从 localStorage 恢复上次的首选引擎（config state 还未初始化）
    try {
      const saved = localStorage.getItem('fs-config');
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed?.translate?.fallback_order?.[0] ?? 'local-llm';
      }
    } catch {}
    return 'local-llm';
  });
  // config 变更时同步下拉框选中值（防止右上角与底部状态栏引擎显示不同步）
  const lastPreferredRef = React.useRef('');
  React.useEffect(() => {
    const pref = config.translate?.fallback_order?.[0] ?? '';
    if (pref && pref !== lastPreferredRef.current) {
      lastPreferredRef.current = pref;
      setEngine(pref);
    }
  }, [config.translate?.fallback_order?.[0]]);
  const [configPath, setConfigPath] = React.useState('');

  // config 的最新值镜像：保存配置时若直接闭包捕获 config，会读到调用时刻的
  // 旧快照（用户可能刚在设置页改过）。ref 保证永远拿到最新值。
  const configRef = React.useRef<SettingsData>({});
  configRef.current = config;

  // 本地图片 OCR 用：隐藏的 <input type=file>，点击「图片」按钮时触发。
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // 外观（明暗 / 强调色 / 字体 / 字号缩放）。必须在 config state 之后声明：
  // useTheme 以 config.json 的值为初值，顺序反了读不到。
  // onChange 把用户改动写回 Rust 持久化（localStorage 已先写一份，保证即时生效）。
  const persistAppearance = React.useCallback(
    (next: { accent: string; font: string; fontScale: number }) => {
      setConfig((c) => ({
        ...c,
        ui_accent: next.accent,
        ui_font: next.font,
        ui_font_scale: next.fontScale,
      }));
      api
        .saveConfig({ ...configRef.current, ui_accent: next.accent, ui_font: next.font, ui_font_scale: next.fontScale })
        .catch((e: unknown) => console.error('[fs] 保存外观配置失败', e));
    },
    [api],
  );

  const {
    theme,
    setTheme,
    accentId,
    setAccent,
    fontId,
    setFont,
    fontScale,
    setFontScale,
  } = useTheme({
    initialAccent: config.ui_accent,
    initialFont: config.ui_font,
    initialFontScale: config.ui_font_scale ?? undefined,
    onChange: persistAppearance,
  });
  const [engines, setEngines] = React.useState<EngineInfo[]>([]);
  const [history, setHistory] = React.useState<HistoryItem[]>([]);
  /** 最近一次管线的引擎信息（状态栏显示「实际是谁翻译的」）。 */
  const [lastRun, setLastRun] = React.useState<PipelineSnapshot | null>(null);

  const [chatMessages, setChatMessages] = React.useState<ChatMessage[]>([]);
  const [chatStreaming, setChatStreaming] = React.useState(false);

  // 轻量 toast：引擎切换等即时反馈（不引入新依赖/新组件文件）
  const [toast, setToast] = React.useState<string | null>(null);
  const showToast = React.useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1600);
  }, []);

  // 初始化：拉状态、配置、引擎列表与历史（骨架：忽略失败，便于浏览器预览）
  React.useEffect(() => {
    if (label !== 'main') return;
    api
      .getStatus()
      .then((s) => {
        setOcrReady(s.ocr_ready);
        setConfig((s.config as SettingsData) ?? {});
        setConfigPath(s.config_path);
      })
      .catch(() => {});
    api
      .listEngines()
      .then(setEngines)
      .catch(() => {});
    api
      .getHistory(50)
      .then((h) => setHistory(h as HistoryItem[]))
      .catch(() => {});
  }, [api]);

  // 主窗体监听 Rust 广播的 `translation-ready`（选区截图 / 全局热键完成时推送），
  // 用最新原文+译文刷新工作区。选区窗口不需要此监听。
  //
  // 注意：必须对「桥未就绪」重试而不是静默放弃。__TAURI__ 全局是页面脚本执行后
  // 才注入的，若首次 effect 跑得早一步，监听将永远注册不上——真机症状是
  // 「Rust 日志 ok(原文/译文都有) 但界面两个区都是 0 字」，且完全无报错。
  React.useEffect(() => {
    if (label !== 'main') return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenCycle: (() => void) | undefined;
    let timer: number | undefined;
    let tries = 0;

    const attach = () => {
      if (disposed) return;
      const tauri = (window as unknown as { __TAURI__?: any }).__TAURI__;
      const listen = tauri?.event?.listen;
      if (typeof listen !== 'function') {
        // 桥还没注入完，退避重试；超过 60 次（约 30s）放弃并留日志。
        if (++tries <= 60) {
          timer = window.setTimeout(attach, 500);
        } else {
          console.error('[fs] __TAURI__.event.listen 始终不可用，translation-ready 无法接收');
        }
        return;
      }
      const p = listen('translation-ready', (e: { payload: { source?: string; translation?: string } }) => {
        setSource(e.payload?.source ?? '');
        setTranslation(e.payload?.translation ?? '');
        api.getHistory(50).then((h) => setHistory(h as HistoryItem[])).catch(() => {});
        // 事件载荷不含「实际服务引擎」，补拉一次权威快照供状态栏显示。
        pullResult(api, setSource, setTranslation, setLastRun);
      });
      // `cycle_engine` 全局热键（Ctrl+Alt+E）切换首选引擎后 Rust 广播此事件。
      // 收到就弹出 toast + 重拉配置 + 引擎列表 + 结果，让下拉框、状态栏与设置页立即反映新的降级链顺序。
      const c = listen('engine-cycled', (e: { payload?: string }) => {
        const newPrimary = e?.payload ?? '';
        if (newPrimary) {
          const label =
            engines.find((x) => x.id === newPrimary)?.label ??
            ENGINES.find((x) => x.value === newPrimary)?.label ??
            newPrimary;
          showToast(`已切换至 ${label}`);
          setEngine(newPrimary); // ★ 同步下拉框选中值
        }
        api.getStatus()
          .then((st) => setConfig((st.config ?? {}) as SettingsData))
          .catch(() => {});
        api
          .listEngines()
          .then(setEngines) // ★ 刷新引擎列表（含可用性变化 / 新注册引擎如 argos）
          .catch(() => {});
        pullResult(api, setSource, setTranslation, setLastRun);
      });
      if (c && typeof c.then === 'function') {
        c.then((u: () => void) => {
          if (disposed) {
            u?.();
            return;
          }
          unlistenCycle = u;
        }).catch(() => {});
      }
      if (p && typeof p.then === 'function') {
        p.then((u: () => void) => {
          if (disposed) {
            u?.();
            return;
          }
          unlisten = u;
          console.log('[fs] translation-ready listener attached after', tries, 'retry(ies)');
          // 兜底 #1：监听刚就绪就主动拉一次。若上一次结果是在监听注册前
          // 产生的（例如程序刚启动时用户就按了热键），这里能把它捞回来。
          pullResult(api, setSource, setTranslation, setLastRun);
        }).catch((err: unknown) => {
          console.error('[fs] listen 注册失败', err);
        });
      }
    };

    attach();
    // 兜底 #2：主窗口每次重新可见（框选后被 show 回来）都拉一次最新结果。
    // 事件是单向的、可能丢失；窗口可见性变化是可靠信号，能兜住绝大多数丢事件场景。
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        pullResult(api, setSource, setTranslation, setLastRun);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      if (unlistenCycle) unlistenCycle();
      if (unlisten) unlisten();
    };
  }, [api, label]);

  const effectiveSrc = srcLang === 'auto' ? undefined : srcLang;

  // —— 工具栏 / 命令条统一动作入口 ——
  const doScreenshot = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await api.screenshotTranslate(effectiveSrc, dstLang);
      setSource(r.source);
      setTranslation(r.translation);
      api.getHistory(50).then((h) => setHistory(h as HistoryItem[])).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [api, effectiveSrc, dstLang]);

  const doPaste = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setError('剪贴板为空');
        return;
      }
      setSource(text);
      const t = await api.translateText(text, effectiveSrc ?? 'auto', dstLang);
      setTranslation(t);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [api, effectiveSrc, dstLang]);

  const doCopy = React.useCallback(
    async (which: 'source' | 'translation') => {
      const text = which === 'source' ? source : translation;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        setError(String(e));
      }
    },
    [source, translation],
  );

  const doSpeak = React.useCallback(
    (which: 'source' | 'translation') => {
      const text = which === 'source' ? source : translation;
      if (!text || typeof speechSynthesis === 'undefined') return;
      const lang = which === 'source' ? srcLang : dstLang;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang === 'auto' ? 'zh' : lang;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    },
    [source, translation, srcLang, dstLang],
  );

  const doSwap = React.useCallback(() => {
    // 语言选择器与双栏内容一并交换，符合经典翻译器「两框互换」心智模型
    setSrcLang(dstLang);
    setDstLang(srcLang);
    setSource(translation);
    setTranslation(source);
  }, [srcLang, dstLang, source, translation]);

  const doClear = React.useCallback(() => {
    setSource('');
    setTranslation('');
    setError(undefined);
  }, []);

  const doRetranslate = React.useCallback(async () => {
    if (!source.trim()) return;
    setLoading(true);
    setError(undefined);
    try {
      const t = await api.translateText(source, effectiveSrc ?? 'auto', dstLang);
      setTranslation(t);
      api.getHistory(50).then((h) => setHistory(h as HistoryItem[])).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [api, source, effectiveSrc, dstLang]);

  // 把 File 读成 base64（去掉 data: 前缀），交给 Rust 解码 + OCR。
  const fileToBase64 = React.useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = (reader.result as string) ?? '';
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }, []);

  // 「图片」按钮：弹出系统文件选择器，选中的图走本地 OCR 翻译。
  const doImage = React.useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onImageFile = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // 清空 value，保证同一文件可被重复选中触发 onChange。
      e.target.value = '';
      if (!file) return;
      setLoading(true);
      setError(undefined);
      try {
        const b64 = await fileToBase64(file);
        const r = await api.translateImageBytes(b64, effectiveSrc, dstLang);
        setSource(r.source);
        setTranslation(r.translation);
        api.getHistory(50).then((h) => setHistory(h as HistoryItem[])).catch(() => {});
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [api, effectiveSrc, dstLang],
  );

  const toggleDrawer = React.useCallback((key: DrawerKey) => {
    setActiveDrawer((cur) => (cur === key ? null : key));
  }, []);

  const sendChat = React.useCallback(
    async (text: string) => {
      // 把当前译文（及可选原文）作为 system 上下文注入对话引擎，让助手优先依据面板文本回答。
      // system 上下文**不进入可见历史**（避免重复累积、也避免作为假「助手」气泡渲染），
      // 每次发送时重新注入即可。
      const ctx: ChatMessage[] = [];
      if (translation && translation.trim()) {
        let sys = `你正在协助用户处理 OCR 识别后的文本。当前面板里显示的译文如下：\n"""\n${translation}\n"""`;
        if (source && source.trim()) sys += `\n对应的 OCR 原文如下：\n"""\n${source}\n"""`;
        sys += `\n回答用户关于这些文本的问题时，优先依据上面给出的译文/原文。`;
        ctx.push({ role: 'system', content: sys });
      }
      // 可见历史只保留 user/assistant 轮次
      const visible: ChatMessage[] = [...chatMessages, { role: 'user', content: text }];
      setChatMessages(visible);
      setChatStreaming(true);
      try {
        // 实际发给后端：system 上下文 + 可见历史 + 本次用户输入
        const payload: ChatMessage[] = [...ctx, ...visible];
        const reply = await api.chat(payload);
        setChatMessages((m) => [...m, { role: 'assistant', content: reply }]);
      } catch (e) {
        setChatMessages((m) => [...m, { role: 'assistant', content: `错误: ${String(e)}` }]);
      } finally {
        setChatStreaming(false);
      }
    },
    [api, chatMessages, translation, source],
  );

  const saveConfig = React.useCallback(
    async (cfg: SettingsData) => {
      try {
        await api.saveConfig(cfg);
        setConfig(cfg);
        setError(undefined);
        // 密钥/降级链变了，引擎可用状态随之变化，刷新列表
        api.listEngines().then(setEngines).catch(() => {});
      } catch (e) {
        // 必须 rethrow：设置页「应用并保存」依赖 catch 来显示失败原因。
        // 此前只 setError 不抛，设置页因此永远拿不到失败反馈——用户只看到
        // 「按了没反应」。setError 保留，让工作区也能看到。
        setError(String(e));
        throw e;
      }
    },
    [api],
  );

  // 热键录入期间挂起全局热键：不挂起的话，用户按下 Alt+Q 的瞬间 Rust 侧就弹出
  // 框选遮罩抢走焦点，前端 keydown 收不到这次按键 → 永远录不进新键。
  const suspendHotkeys = React.useCallback(
    (listening: boolean) => {
      api.setHotkeysSuspended(listening).catch(() => {});
    },
    [api],
  );

  const reloadConfig = React.useCallback(() => {
    api
      .getStatus()
      .then((s) => {
        setConfig((s.config as SettingsData) ?? {});
        setConfigPath(s.config_path);
      })
      .catch(() => {});
  }, [api]);

  const testConnection = React.useCallback(
    async (endpoint: string, model: string) => {
      try {
        const r = await api.translateText('ping', 'auto', 'zh');
        return r ? `端点可达（模型 ${model} @ ${endpoint || '默认'}）` : '连接失败';
      } catch (e) {
        return `连接失败: ${String(e)}`;
      }
    },
    [api],
  );

  const testEngine = React.useCallback(
    async (id: string) => api.testEngine(id),
    [api],
  );

  const pickHistory = React.useCallback((item: HistoryItem) => {
    setSource(item.source);
    setTranslation(item.target);
    setActiveDrawer(null);
  }, []);

  const clearHistory = React.useCallback(() => {
    api
      .clearHistory()
      .then(() => setHistory([]))
      .catch((e) => setError(String(e)));
  }, [api]);

  const onAction = React.useCallback(
    (key: string) => {
      switch (key) {
        case 'screenshot':
          setMode('screenshot');
          void doScreenshot();
          break;
        case 'region':
          // 框选已于 2026-10-03 移除，此分支不再可达（工具栏已无该项、Alt+2 已不注册）。
          // 保留空分支仅为兼容历史 key，避免落到 default 打日志。
          break;
        case 'paste':
          void doPaste();
          break;
        case 'copy':
          void doCopy('translation');
          break;
        case 'speak':
          doSpeak('translation');
          break;
        case 'swap':
          doSwap();
          break;
        case 'clear':
          doClear();
          break;
        case 'history':
          toggleDrawer('history');
          break;
        case 'image':
          doImage();
          break;
        case 'chat':
          toggleDrawer('chat');
          break;
        case 'settings':
          toggleDrawer('settings');
          break;
        case '__closeDrawer':
          setActiveDrawer(null);
          break;
        default:
          break;
      }
    },
    [doScreenshot, doPaste, doCopy, doSpeak, doSwap, doClear, toggleDrawer],
  );

  const engineLabel = ENGINES.find((e) => e.value === engine)?.label ?? engine;
  const charCount = countChars(source) + countChars(translation);
  // 面板内「朗读」是否可用：WebView2（Chromium）原生支持 speechSynthesis，
  // 故只要全局 API 存在就放开，不再默认置灰。
  const ttsSupported =
    typeof window !== 'undefined' && typeof (window as unknown as { speechSynthesis?: unknown }).speechSynthesis !== 'undefined';
  // 降级链的可读文本（状态栏 tooltip 用）：把 id 翻成 label，未知 id 原样显示。
  const fallbackChainLabel = (config.translate?.fallback_order ?? [])
    .map((id: string) => engines.find((e) => e.id === id)?.label ?? id)
    .join(' → ') || '（未配置）';

  // 状态栏引擎主指标：显示**当前首选引擎**（配置降级链首项），而不是上次实际服务的引擎——
  // 否则用户按 Ctrl+Alt+E 切了首选也看不出来（lastRun 是上次实际服务的，被降级链换走时与首选不同）。
  const actualEngineId = lastRun?.engine ?? '';
  const actualEngineLabel = actualEngineId
    ? (engines.find((e) => e.id === actualEngineId)?.label ??
       ENGINES.find((e) => e.value === actualEngineId)?.label ??
       actualEngineId)
    : '';
  const preferredEngineId = config.translate?.fallback_order?.[0] ?? '';
  const preferredEngineLabel = preferredEngineId
    ? (engines.find((e) => e.id === preferredEngineId)?.label ??
       ENGINES.find((e) => e.value === preferredEngineId)?.label ??
       preferredEngineId)
    : '';

  // 引擎下拉选项：**以后端 list_engines 为准**（含 argos 等全部注册引擎），
  // 不可用的置灰而非隐藏 —— 让用户知道「有这个引擎但缺配置」，
  // 这是与降级链语义一致的信息（registry 只轮换 available 的引擎）。
  // 仅当后端返回空（浏览器预览 / 桥未就绪）时才退回静态兜底表。
  const engineOptions: SelectOption[] =
    engines.length > 0
      ? engines.map((e) => ({
          value: e.id,
          label: e.available ? e.label : `${e.label}（不可用）`,
          disabled: !e.available,
        }))
      : ENGINES;

  const selectedEngineAvailable = engines.find((e) => e.id === preferredEngineId)?.available;

  const engineCell = preferredEngineId ? (
    <span key="engine" title={`降级链：${fallbackChainLabel}`}>
      <StatusDot tone={selectedEngineAvailable === false ? 'warn' : 'ok'} />
      引擎 · {preferredEngineLabel}
      {selectedEngineAvailable === false ? '（不可用，将走降级链）' : ''}
      {lastRun && lastRun.engine === preferredEngineId && lastRun.engine_chain_len > 0
        ? ` (第 ${lastRun.engine_position}/${lastRun.engine_chain_len} 环)`
        : ''}
      {lastRun && lastRun.engine !== 'none' && lastRun.engine !== preferredEngineId && lastRun.engine_chain_len > 0
        ? ` · 上次:${actualEngineLabel}(第${lastRun.engine_position}/${lastRun.engine_chain_len}环)`
        : ''}
    </span>
  ) : (
    // 尚未配置降级链：显示当前 engine 状态（明确标注「首选，未使用」）
    <span key="engine" title={`降级链：${fallbackChainLabel}`}>
      引擎 · {engineLabel}（首选，未使用）
    </span>
  );

  const statusLeft: React.ReactNode[] = [
    <span key="brand">全场景OCR翻译</span>,
    <React.Fragment key="ocr">
      <StatusDot tone={ocrReady ? 'ok' : 'warn'} />
      <span>{ocrReady ? 'OCR 就绪' : 'OCR 降级'}</span>
    </React.Fragment>,
    engineCell,
    <span key="count">{charCount} 字</span>,
  ];

  const statusRight: React.ReactNode[] = [
    <span key="lang">{srcLang === 'auto' ? '自动' : srcLang} → {dstLang}</span>,
    <span key="theme">{theme === 'dark' ? '深色' : '浅色'}</span>,
    loading ? <span key="busy">处理中…</span> : null,
  ];

  const drawers: Partial<Record<DrawerKey, DrawerSpec>> = {};
  if (activeDrawer === 'chat') {
    drawers.chat = {
      title: 'AI 助手',
      subtitle: translation ? `已引用当前译文 ${countChars(translation)} 字` : undefined,
      body: <Chat messages={chatMessages} streaming={chatStreaming} onSend={sendChat} />,
    };
  } else if (activeDrawer === 'history') {
    drawers.history = {
      title: '翻译历史',
      body: <History items={history} onPick={pickHistory} onClear={clearHistory} />,
    };
  } else if (activeDrawer === 'settings') {
    drawers.settings = {
      title: '设置',
      body: (
        <Settings
          initial={config}
          configPath={configPath}
          theme={theme}
          engines={engines}
          onThemeChange={setTheme}
          onAccentChange={setAccent}
          onFontChange={setFont}
          onFontScaleChange={setFontScale}
          accentId={accentId}
          fontId={fontId}
          fontScale={fontScale}
          onSave={saveConfig}
          onReload={reloadConfig}
          error={error}
          onTestConnection={testConnection}
          onTestEngine={testEngine}
          onHotkeyCapture={suspendHotkeys}
        />
      ),
    };
  }

  // 选区窗口（label === 'selection'）已于 2026-10-03 随「砍掉框选」一并移除：
  // 该 overlay 全屏透明窗口从未真机验证通过，且为真机崩溃源之一（见 docs/项目规范.md §5.2 P1）。
  // Rust 侧 open_selection / selection_done / close_selection 命令同步下线。

  return (
    <>
      <AppShell
        mode={mode}
        activeDrawer={activeDrawer}
        onAction={onAction}
        railDisabled={[]}
        statusLeft={statusLeft}
        statusRight={statusRight}
        drawers={drawers}
      >
        <Workspace
          source={source}
          translation={translation}
          onChangeSource={setSource}
          onChangeTranslation={setTranslation}
          loading={loading}
          error={error}
          srcLang={srcLang}
          dstLang={dstLang}
          engine={engine}
          engines={engineOptions}
          onLangChange={(which, value) => (which === 'src' ? setSrcLang(value) : setDstLang(value))}
          onSwapLang={doSwap}
          onEngineChange={setEngine}
          onRetranslate={doRetranslate}
          onCopy={doCopy}
          onSpeak={doSpeak}
          speakSupported={ttsSupported}
        />
        {/* 本地图片 OCR 用：隐藏的文件选择器，点击「图片」按钮时触发 */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={onImageFile}
        />
      </AppShell>
      {/* 引擎切换等即时反馈 toast（极简，无新依赖） */}
      {toast ? (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#1677ff',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 8,
            zIndex: 9999,
            fontSize: 13,
          }}
        >
          {toast}
        </div>
      ) : null}
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
