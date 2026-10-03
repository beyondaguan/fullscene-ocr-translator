import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell, type WorkspaceMode, type DrawerKey, type DrawerSpec } from './layouts/AppShell';
import { Workspace, ENGINES } from './layouts/Workspace';
import { Chat, type ChatMessage } from './layouts/Chat';
import { History, type HistoryItem } from './layouts/History';
import { Settings, type SettingsData } from './layouts/Settings';
import { useTheme } from './hooks/useTheme';
import { createNativeMsgApi, type EngineInfo } from './hooks/useNativeMsg';
import { StatusDot } from './components/StatusBar';
import { countChars } from './utils/text';
import './tokens.css';
import './global.css';

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
  const { theme, setTheme } = useTheme();
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
  const [engine, setEngine] = React.useState('local-llm');

  const [ocrReady, setOcrReady] = React.useState(false);
  const [config, setConfig] = React.useState<SettingsData>({});
  const [configPath, setConfigPath] = React.useState('');
  const [engines, setEngines] = React.useState<EngineInfo[]>([]);
  const [history, setHistory] = React.useState<HistoryItem[]>([]);

  const [chatMessages, setChatMessages] = React.useState<ChatMessage[]>([]);
  const [chatStreaming, setChatStreaming] = React.useState(false);

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
  React.useEffect(() => {
    if (label !== 'main') return;
    const tauri = (window as unknown as { __TAURI__?: any }).__TAURI__;
    const listen = tauri?.event?.listen;
    if (typeof listen !== 'function') return;
    let unlisten: (() => void) | undefined;
    const p = listen('translation-ready', (e: { payload: { source: string; translation: string } }) => {
      setSource(e.payload.source);
      setTranslation(e.payload.translation);
      api.getHistory(50).then((h) => setHistory(h as HistoryItem[])).catch(() => {});
    });
    if (p && typeof p.then === 'function') {
      p.then((u: () => void) => {
        unlisten = u;
      });
    }
    return () => {
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

  const toggleDrawer = React.useCallback((key: DrawerKey) => {
    setActiveDrawer((cur) => (cur === key ? null : key));
  }, []);

  const sendChat = React.useCallback(
    async (text: string) => {
      setChatMessages((m) => [...m, { role: 'user', content: text }]);
      setChatStreaming(true);
      try {
        const reply = await api.translateText(text, effectiveSrc ?? 'auto', dstLang);
        setChatMessages((m) => [...m, { role: 'assistant', content: reply }]);
      } catch (e) {
        setChatMessages((m) => [...m, { role: 'assistant', content: `错误: ${String(e)}` }]);
      } finally {
        setChatStreaming(false);
      }
    },
    [api, effectiveSrc, dstLang],
  );

  const saveConfig = React.useCallback(
    async (cfg: SettingsData) => {
      try {
        await api.saveConfig(cfg);
        setConfig(cfg);
        // 密钥/降级链变了，引擎可用状态随之变化，刷新列表
        api.listEngines().then(setEngines).catch(() => {});
      } catch (e) {
        setError(String(e));
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

  const statusLeft: React.ReactNode[] = [
    <span key="brand">全场景OCR翻译</span>,
    <React.Fragment key="ocr">
      <StatusDot tone={ocrReady ? 'ok' : 'warn'} />
      <span>{ocrReady ? 'OCR 就绪' : 'OCR 降级'}</span>
    </React.Fragment>,
    <span key="engine">引擎 · {engineLabel}</span>,
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
          onSave={saveConfig}
          onReload={reloadConfig}
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
    <AppShell
      mode={mode}
      activeDrawer={activeDrawer}
      onAction={onAction}
      railDisabled={['image']}
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
        onLangChange={(which, value) => (which === 'src' ? setSrcLang(value) : setDstLang(value))}
        onSwapLang={doSwap}
        onEngineChange={setEngine}
        onRetranslate={doRetranslate}
        onCopy={doCopy}
        onSpeak={doSpeak}
      />
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
