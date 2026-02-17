import { beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageHandler = (request: any, sender?: any) => Promise<any> | any;

describe('background forwarding observability', () => {
  let runtimeMessageHandler: RuntimeMessageHandler | undefined;
  let runtimeConnectHandler: ((port: any) => void) | undefined;
  let browserMock: any;

  async function loadBackgroundEntrypoint() {
    vi.resetModules();
    runtimeMessageHandler = undefined;
    runtimeConnectHandler = undefined;

    browserMock = {
      runtime: {
        onInstalled: {
          addListener: vi.fn(),
        },
        onMessage: {
          addListener: vi.fn((listener: RuntimeMessageHandler) => {
            runtimeMessageHandler = listener;
          }),
        },
        onConnect: {
          addListener: vi.fn((listener: (port: any) => void) => {
            runtimeConnectHandler = listener;
          }),
        },
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      action: {
        onClicked: {
          addListener: vi.fn(),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined),
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      contextMenus: {
        create: vi.fn(),
        update: vi.fn(),
        onClicked: {
          addListener: vi.fn(),
        },
      },
      sidePanel: {
        setPanelBehavior: vi.fn().mockResolvedValue(undefined),
        setOptions: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(undefined),
      },
    };

    (globalThis as any).chrome = {
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      },
    };

    vi.doMock('wxt/browser', () => ({
      browser: browserMock,
    }));

    vi.doMock('wxt/sandbox', () => ({
      defineBackground: (callback: () => void) => callback,
    }));

    const mod = await import('../entrypoints/background');
    const init = mod.default as unknown as () => void;
    init();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await loadBackgroundEntrypoint();
  });

  it('warns and still returns success when syncSidepanel sidepanel relay fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const disconnectedPort = {
      name: 'sidepanel-sync',
      postMessage: vi.fn(() => {
        throw new Error('port disconnected');
      }),
      onDisconnect: {
        addListener: vi.fn(),
      },
    };
    runtimeConnectHandler?.(disconnectedPort);

    const result = await runtimeMessageHandler?.({ action: 'syncSidepanel' }, undefined);

    expect(result).toEqual({ success: true });
    expect(browserMock.runtime.sendMessage).not.toHaveBeenCalled();
    expect(disconnectedPort.postMessage).toHaveBeenCalledTimes(1);
    expect(disconnectedPort.postMessage).toHaveBeenCalledWith({ action: 'syncSidepanel' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[background] syncSidepanel sidepanel relay failed'),
      expect.any(Error),
    );
  });

  it('warns on tab relay failure and continues to remaining tabs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    browserMock.tabs.query.mockResolvedValueOnce([{ id: 101 }, { id: 102 }]);
    browserMock.tabs.sendMessage
      .mockRejectedValueOnce(new Error('content script missing'))
      .mockResolvedValueOnce(undefined);

    const result = await runtimeMessageHandler?.({ action: 'roomChange', pair: 'ETH-USD', market: 'Perps' }, undefined);

    expect(result).toEqual({ success: true });
    expect(browserMock.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(browserMock.tabs.sendMessage).toHaveBeenNthCalledWith(1, 101, {
      action: 'roomChange',
      pair: 'ETH-USD',
      market: 'Perps',
    });
    expect(browserMock.tabs.sendMessage).toHaveBeenNthCalledWith(2, 102, {
      action: 'roomChange',
      pair: 'ETH-USD',
      market: 'Perps',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[background] roomChange tab relay (tab 101) failed'),
      expect.any(Error),
    );
  });
});
