/**
 * Native Messaging 客户端单元测试：FIFO 关联、错误处理、断线重连。
 * 注入 chrome.runtime.connectNative mock。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { disconnect, sendMessage, pendingCount } from '../src/nm/client';
import type { ChromePort } from '../src/nm/client';

/** 构建一个最小 ChromePort mock */
function makePortMock() {
  const listeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: ChromePort = {
    postMessage: vi.fn(),
    onMessage: {
      addListener: (cb) => listeners.push(cb),
      removeListener: () => undefined,
    },
    onDisconnect: {
      addListener: (cb) => disconnectListeners.push(cb),
      removeListener: () => undefined,
    },
    disconnect: vi.fn(() => {
      disconnectListeners.forEach((cb) => cb());
    }),
  };
  return { port, listeners, disconnectListeners };
}

function installConnectNativeMock(port: ChromePort) {
  const runtimeMock = {
    connectNative: vi.fn(() => port),
  };
  (globalThis as unknown as { chrome?: { runtime?: unknown } }).chrome = {
    runtime: runtimeMock,
  };
  return runtimeMock;
}

beforeEach(() => {
  disconnect();
});

afterEach(() => {
  disconnect();
  vi.restoreAllMocks();
});

describe('nm/client', () => {
  it('connect 建立连接并维护 FIFO', async () => {
    const { port, listeners } = makePortMock();
    installConnectNativeMock(port);

    const p1 = sendMessage({ type: 'Ping' });
    const p2 = sendMessage({ type: 'Ping' });
    expect(pendingCount()).toBe(2);

    // 按发送顺序回包
    listeners[0]({ type: 'Pong' });
    listeners[0]({ type: 'Pong' });

    const r1 = await p1;
    const r2 = await p2;
    expect(r1.type).toBe('Pong');
    expect(r2.type).toBe('Pong');
    expect(pendingCount()).toBe(0);
  });

  it('断线拒绝所有待处理请求', async () => {
    const { port, disconnectListeners } = makePortMock();
    installConnectNativeMock(port);

    const p = sendMessage({ type: 'Ping' });
    disconnectListeners.forEach((cb) => cb());

    await expect(p).rejects.toThrow('连接已断开');
    expect(pendingCount()).toBe(0);
  });

  it('connectNative 不可用时 sendMessage 抛错', async () => {
    (globalThis as unknown as { chrome?: unknown }).chrome = { runtime: {} };
    await expect(sendMessage({ type: 'Ping' })).rejects.toThrow('connectNative');
  });
});