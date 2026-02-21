import { beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION_STORAGE_KEY = 'waku_auth_lite_session_v1';

function createStorageSessionArea() {
  const data: Record<string, unknown> = {};
  const area = {
    get: vi.fn(async (key: string | string[]) => {
      if (Array.isArray(key)) {
        return key.reduce<Record<string, unknown>>((acc, item) => {
          acc[item] = data[item];
          return acc;
        }, {});
      }
      return { [key]: data[key] };
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
    remove: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      keys.forEach((item) => {
        delete data[item];
      });
    }),
  };
  return { area, data };
}

async function loadClientClass() {
  const module = await import('../lib/waku-chat-client.js');
  return module.WakuChatClient;
}

function buildSession(overrides: Partial<Record<string, string>> = {}) {
  const base = {
    sessionId: 'persisted-session-id',
    sessionPrivKeyHex: '11'.repeat(32),
    sessionPubKeyHex: `02${'22'.repeat(32)}`,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    address: '0x1234567890123456789012345678901234567890',
    contentTopic: '/waku-auth-lite/1/BTC-USD_Perps/json',
    pubsubTopic: '/waku/2/rs/999/0',
    gatewayUrl: 'http://localhost:8787',
  };
  return { ...base, ...overrides };
}

describe('WakuChatClient session persistence', () => {
  beforeEach(() => {
    (globalThis as any).chrome = (globalThis as any).chrome || {};
    (globalThis as any).chrome.runtime = (globalThis as any).chrome.runtime || { lastError: null, getURL: vi.fn((p: string) => p) };
    (globalThis as any).chrome.storage = (globalThis as any).chrome.storage || {};
  });

  it('restores a valid persisted session and skips session creation request', async () => {
    const { area } = createStorageSessionArea();
    (globalThis as any).chrome.storage.session = area;

    const WakuChatClient = await loadClientClass();
    const warmClient = new WakuChatClient({ gatewayUrl: 'http://localhost:8787' });
    const persistedSession = buildSession();
    await warmClient._saveSessionToStorage(persistedSession);

    const client = new WakuChatClient({
      gatewayUrl: 'http://localhost:8787',
      signMessage: vi.fn().mockResolvedValue('0xmocked'),
    });
    client.setWalletInfo('0x1234567890123456789012345678901234567890');
    client.setRoom('BTC-USD', 'Perps');
    const gatewayRequest = vi.fn();
    client._gatewayRequest = gatewayRequest;

    const session = await client._ensureSession();
    expect(session.sessionId).toBe(persistedSession.sessionId);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('discards incompatible persisted session and creates a new one', async () => {
    const { area } = createStorageSessionArea();
    (globalThis as any).chrome.storage.session = area;

    const WakuChatClient = await loadClientClass();
    const warmClient = new WakuChatClient({ gatewayUrl: 'http://localhost:8787' });
    await warmClient._saveSessionToStorage(
      buildSession({
        address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    );

    const signer = vi.fn().mockResolvedValue('0xmocked-signature');
    const gatewayResponse = {
      sessionId: 'fresh-session-id',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    const client = new WakuChatClient({
      gatewayUrl: 'http://localhost:8787',
      signMessage: signer,
    });
    client.setWalletInfo('0x1234567890123456789012345678901234567890');
    client.setRoom('BTC-USD', 'Perps');
    client._gatewayRequest = vi.fn(async (path: string) => {
      if (path === '/session') return gatewayResponse;
      throw new Error(`Unexpected path: ${path}`);
    });

    const session = await client._ensureSession();
    expect(session.sessionId).toBe('fresh-session-id');
    expect(client._gatewayRequest).toHaveBeenCalled();
    expect(area.remove).toHaveBeenCalledWith(SESSION_STORAGE_KEY, expect.any(Function));
  });

  it('invalidates persisted session when gateway endpoint changes between client instances', async () => {
    const { area, data } = createStorageSessionArea();
    (globalThis as any).chrome.storage.session = area;

    const WakuChatClient = await loadClientClass();
    const oldGateway = 'http://localhost:8787';
    const newGateway = 'https://gw-b.example';

    const warmClient = new WakuChatClient({ gatewayUrl: oldGateway });
    await warmClient._saveSessionToStorage(buildSession({ gatewayUrl: oldGateway }));

    const client = new WakuChatClient({
      gatewayUrl: newGateway,
      signMessage: vi.fn().mockResolvedValue('0xmocked-signature'),
    });
    client.setWalletInfo('0x1234567890123456789012345678901234567890');
    client.setRoom('BTC-USD', 'Perps');
    client._gatewayRequest = vi.fn(async (path: string) => {
      if (path === '/session') {
        return {
          sessionId: 'fresh-session-after-gateway-change',
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const session = await client._ensureSession();
    expect(session.sessionId).toBe('fresh-session-after-gateway-change');
    expect(client._gatewayRequest).toHaveBeenCalledTimes(1);
    expect(area.remove).toHaveBeenCalledWith(SESSION_STORAGE_KEY, expect.any(Function));
    const persisted = (data[SESSION_STORAGE_KEY] as any)?.session;
    expect(persisted?.gatewayUrl).toBe(newGateway);
  });

  it('invalidates in-memory session when gateway endpoint changes at runtime', async () => {
    const { area } = createStorageSessionArea();
    (globalThis as any).chrome.storage.session = area;

    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({
      gatewayUrl: 'http://localhost:8787',
      signMessage: vi.fn().mockResolvedValue('0xmocked-signature'),
    });
    client.setWalletInfo('0x1234567890123456789012345678901234567890');
    client.setRoom('BTC-USD', 'Perps');
    client.session = buildSession({
      sessionId: 'old-in-memory-session',
      gatewayUrl: 'http://localhost:8787',
    });

    client.gatewayUrl = 'https://gw-c.example';
    client.gatewayDomain = 'gw-c.example';
    client._gatewayRequest = vi.fn(async (path: string) => {
      if (path === '/session') {
        return {
          sessionId: 'fresh-after-runtime-gateway-change',
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const session = await client._ensureSession();
    expect(session.sessionId).toBe('fresh-after-runtime-gateway-change');
    expect(client._gatewayRequest).toHaveBeenCalledTimes(1);
  });

  it('falls back to in-memory session flow when chrome.storage.session is unavailable', async () => {
    const WakuChatClient = await loadClientClass();
    delete (globalThis as any).chrome.storage.session;

    const client = new WakuChatClient({
      gatewayUrl: 'http://localhost:8787',
      signMessage: vi.fn().mockResolvedValue('0xmocked-signature'),
    });
    client.setWalletInfo('0x1234567890123456789012345678901234567890');
    client.setRoom('BTC-USD', 'Perps');
    client._gatewayRequest = vi.fn(async (path: string) => {
      if (path === '/session') {
        return {
          sessionId: 'memory-session-id',
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const session = await client._ensureSession();
    expect(session.sessionId).toBe('memory-session-id');
    expect(client._gatewayRequest).toHaveBeenCalledTimes(1);
  });

  it('clearSession clears both memory and persisted session entry', async () => {
    const { area, data } = createStorageSessionArea();
    (globalThis as any).chrome.storage.session = area;

    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({ gatewayUrl: 'http://localhost:8787' });
    const session = buildSession();
    client.session = session;
    await client._saveSessionToStorage(session);
    expect(data[SESSION_STORAGE_KEY]).toBeTruthy();

    client.clearSession();
    await client._sessionStoragePendingClear;

    expect(client.session).toBeNull();
    expect(data[SESSION_STORAGE_KEY]).toBeUndefined();
  });
});
