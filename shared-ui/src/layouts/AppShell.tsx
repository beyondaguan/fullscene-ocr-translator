import React from 'react';
import { ToolRail, RailItem } from '../components/ToolRail';
import { StatusBar } from '../components/StatusBar';
import { Drawer } from '../components/Drawer';
import {
  IconChat,
  IconClear,
  IconCopy,
  IconHistory,
  IconImage,
  IconPaste,
  IconScreenshot,
  IconSettings,
  IconSpeak,
  IconSwap,
  IconWordbook,
} from '../icons';
import { useHotkey } from '../hooks/useHotkey';

/**
 * 工作模式。
 *
 * 2026-10-03 起**移除 `region`（框选）**：overlay 全屏透明窗口从未真机验证通过
 * （见 docs/项目规范.md §5.2 P1 与版本历史 1.26），且为真机崩溃源之一。
 * 主链「截图→OCR→翻译→回填」稳定后再评估是否恢复。
 */
export type WorkspaceMode = 'screenshot';
export type DrawerKey = 'chat' | 'history' | 'wordbook' | 'settings';

export interface DrawerSpec {
  title: string;
  subtitle?: React.ReactNode;
  context?: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  body: React.ReactNode;
}

export interface AppShellProps {
  /** 当前工作模式（当前只有 screenshot） */
  mode: WorkspaceMode;
  activeDrawer?: DrawerKey | null;
  /** 工具栏与命令条统一回传动作 key */
  onAction: (key: string) => void;
  /** 需要置灰的工具 key（如无译文时禁用「朗读」） */
  railDisabled?: string[];
  statusLeft?: React.ReactNode[];
  statusRight?: React.ReactNode[];
  /** 同一时刻只允许一个抽屉；未提供则视为不渲染 */
  drawers?: Partial<Record<DrawerKey, DrawerSpec>>;
  children: React.ReactNode;
}

/**
 * 应用外壳：单画布。
 *
 * 全应用只有一个画布，历史 / AI 对话 / 设置一律以右侧抽屉覆盖其上，不卸载画布、
 * 不改变滚动位置、不重建空间记忆——这是「视野不脱离」的结构性保证。
 * 状态栏刻意放在抽屉覆盖范围之外，任何时候都可见。
 */
export function AppShell({
  mode,
  activeDrawer = null,
  onAction,
  railDisabled = [],
  statusLeft,
  statusRight,
  drawers,
  children,
}: AppShellProps) {
  const actionRef = React.useRef(onAction);
  actionRef.current = onAction;

  const hots = React.useMemo(
    () => ({
      screenshot: () => actionRef.current('screenshot'),
      chat: () => actionRef.current('chat'),
      history: () => actionRef.current('history'),
      wordbook: () => actionRef.current('wordbook'),
      settings: () => actionRef.current('settings'),
      paste: () => actionRef.current('paste'),
      copy: () => actionRef.current('copy'),
      speak: () => actionRef.current('speak'),
      swap: () => actionRef.current('swap'),
      clear: () => actionRef.current('clear'),
    }),
    [],
  );

  // 截图键（默认 Alt+Q）**不在页面内注册**，理由有两条，都是硬约束：
  // ① RegisterHotKey 是进程级全局的——窗口有焦点时它同样触发。前端再注册一份
  //    就是「一次按键命中两条路径」，会触发两次。
  // ② 实测 window.__TAURI__ 未注入，页面内快捷键本来就收不到（见项目规范 §5.2 P1）。
  // 所以「窗口内 / 窗口外统一为 Alt+Q」的正确实现是：只由 Rust 注册一次。
  useHotkey('Alt+3', hots.chat);
  useHotkey('Alt+4', hots.history);
  useHotkey('Alt+6', hots.wordbook);
  useHotkey('Alt+5', hots.settings);
  // 动作类快捷键（纯应用内，避开全局 Alt+Q / Ctrl+Alt+O，防止重复触发）
  // 粘贴用 Ctrl+V（符合剪贴板习惯，与设置页/占位提示一致）
  useHotkey('Ctrl+V', hots.paste);
  useHotkey('Alt+C', hots.copy);
  useHotkey('Alt+V', hots.speak);
  useHotkey('Alt+X', hots.swap);
  useHotkey('Alt+Backspace', hots.clear);

  const disabled = new Set(railDisabled);

  const groups: RailItem[][] = [
    [
      { key: 'screenshot', label: '截图', kind: 'mode', icon: <IconScreenshot />, title: '截图翻译（Alt+Q 框选 · Ctrl+Alt+O 整屏）' },
      { key: 'image', label: '图片', kind: 'action', icon: <IconImage />, disabled: disabled.has('image'), title: '打开本地图片进行 OCR 翻译' },
      { key: 'paste', label: '粘贴', kind: 'action', icon: <IconPaste />, disabled: disabled.has('paste'), title: '从剪贴板读取文本（Ctrl+V）' },
    ],
    [
      { key: 'copy', label: '复制', kind: 'action', icon: <IconCopy />, disabled: disabled.has('copy'), title: '复制译文（Alt+C）' },
      { key: 'speak', label: '朗读', kind: 'action', icon: <IconSpeak />, disabled: disabled.has('speak'), title: '朗读译文（Alt+V）' },
      { key: 'swap', label: '交换', kind: 'action', icon: <IconSwap />, disabled: disabled.has('swap'), title: '交换源语言与目标语言（Alt+X）' },
      { key: 'clear', label: '清空', kind: 'action', icon: <IconClear />, disabled: disabled.has('clear'), title: '清空画布（Alt+Backspace）' },
    ],
    [
      { key: 'history', label: '历史', kind: 'toggle', icon: <IconHistory />, title: '翻译历史（Alt+4）' },
      { key: 'wordbook', label: '生词本', kind: 'toggle', icon: <IconWordbook />, title: '生词本（Alt+6）' },
      { key: 'chat', label: '对话', kind: 'toggle', icon: <IconChat />, title: 'AI 助手（Alt+3）' },
    ],
  ];

  const spec = activeDrawer ? drawers?.[activeDrawer] : undefined;

  return (
    <div
      className="fs-shell"
      style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-container)' }}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
        <ToolRail
          groups={groups}
          activeMode={mode}
          activeToggle={activeDrawer ?? undefined}
          onSelect={onAction}
          footer={[
            { key: 'settings', label: '设置', kind: 'toggle', icon: <IconSettings />, title: '设置（Alt+5）' },
          ]}
        />

        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{children}</main>

        {spec && (
          <Drawer
            open
            title={spec.title}
            subtitle={spec.subtitle}
            context={spec.context}
            footer={spec.footer}
            width={spec.width}
            onClose={() => onAction('__closeDrawer')}
          >
            {spec.body}
          </Drawer>
        )}
      </div>

      <StatusBar left={statusLeft} right={statusRight} />
    </div>
  );
}
