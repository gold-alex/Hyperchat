import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Wallet Bridge (Vitest)', () => {
  let messageHandler: ((e: MessageEvent) => void) | undefined;
  const authToken = 'bridge-auth-token-12345';
  let nonceCounter = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    nonceCounter = 0;

    // @ts-ignore - test shim
    window.ethereum = undefined;
    // @ts-ignore - test shim
    window.postMessage = vi.fn();

    const originalAddEventListener = window.addEventListener;
    // @ts-ignore
    window.addEventListener = vi.fn((event: string, handler: any) => {
      if (event === 'message') messageHandler = handler;
    });

    // @ts-expect-error side-effect script import
    await import('../public/wallet-bridge.js');

    window.addEventListener = originalAddEventListener;
  });

  function createNoncePayload(overrides: Record<string, unknown> = {}) {
    nonceCounter += 1;
    const requestTsMs = Date.now();
    return {
      nonce: `nonce-${nonceCounter}-abcdef123456`,
      requestTsMs,
      nonceExpiresAtMs: requestTsMs + 10_000,
      ...overrides,
    };
  }

  async function initBridgeToken(token = authToken) {
    await messageHandler!({
      source: window,
      data: { type: 'HL_BRIDGE_AUTH_INIT', id: 'auth-1', authToken: token },
    } as any);
  }

  it('rejects unauthenticated wallet connect requests', async () => {
    // @ts-ignore
    window.ethereum = { request: vi.fn().mockResolvedValue(['0xabc']) };

    await messageHandler!({
      source: window,
      data: { type: 'HL_CONNECT_WALLET_REQUEST', id: 'connect-1', ...createNoncePayload() },
    } as any);

    expect((window as any).ethereum.request).not.toHaveBeenCalled();
    expect(window.postMessage).toHaveBeenCalledWith(
      {
        type: 'HL_CONNECT_WALLET_RESPONSE',
        id: 'connect-1',
        nonce: expect.any(String),
        error: 'Bridge authentication failed',
      },
      '*',
    );
  });

  it('getProvider: returns error when no wallet present after auth', async () => {
    const noncePayload = createNoncePayload();
    await initBridgeToken();

    await messageHandler!({
      source: window,
      data: { type: 'HL_CONNECT_WALLET_REQUEST', id: 'connect-2', authToken, ...noncePayload },
    } as any);

    expect(window.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'HL_CONNECT_WALLET_RESPONSE',
        id: 'connect-2',
        nonce: noncePayload.nonce,
        error: expect.stringContaining('No Ethereum wallet'),
      }),
      '*',
    );
  });

  it('prefers Rabby over MetaMask for authenticated connect requests', async () => {
    // @ts-ignore
    window.ethereum = {
      providers: [
        { isMetaMask: true, request: vi.fn().mockResolvedValue(['0xmetamask']) },
        { isRabby: true, request: vi.fn().mockResolvedValue(['0xrabby']) },
      ],
    };
    const noncePayload = createNoncePayload();
    await initBridgeToken();

    await messageHandler!({
      source: window,
      data: { type: 'HL_CONNECT_WALLET_REQUEST', id: 'connect-3', authToken, ...noncePayload },
    } as any);

    // @ts-ignore
    expect(window.ethereum.providers[1].request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
    expect(window.postMessage).toHaveBeenCalledWith(
      { type: 'HL_CONNECT_WALLET_RESPONSE', id: 'connect-3', nonce: noncePayload.nonce, accounts: ['0xrabby'] },
      '*',
    );
  });

  it('handles authenticated HL_SIGN_REQUEST and posts signature', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(['0xabc'])
      .mockResolvedValueOnce('0xsignature');
    // @ts-ignore
    window.ethereum = { request };
    const noncePayload = createNoncePayload();

    await initBridgeToken();

    await messageHandler!({
      source: window,
      data: { type: 'HL_SIGN_REQUEST', id: 'sign-1', message: 'Hello', address: '0xabc', authToken, ...noncePayload },
    } as any);

    expect(request).toHaveBeenNthCalledWith(1, { method: 'eth_accounts' });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: 'personal_sign',
      params: ['Hello', '0xabc'],
    });
    expect(window.postMessage).toHaveBeenCalledWith(
      { type: 'HL_SIGN_RESPONSE', id: 'sign-1', nonce: noncePayload.nonce, signature: '0xsignature' },
      '*',
    );
  });

  it('rejects replayed nonces before provider call', async () => {
    const request = vi.fn().mockResolvedValue(['0xabc']);
    // @ts-ignore
    window.ethereum = { request };
    const noncePayload = createNoncePayload();

    await initBridgeToken();

    await messageHandler!({
      source: window,
      data: { type: 'HL_CONNECT_WALLET_REQUEST', id: 'connect-replay-1', authToken, ...noncePayload },
    } as any);
    await messageHandler!({
      source: window,
      data: { type: 'HL_CONNECT_WALLET_REQUEST', id: 'connect-replay-2', authToken, ...noncePayload },
    } as any);

    expect(request).toHaveBeenCalledTimes(1);
    expect(window.postMessage).toHaveBeenLastCalledWith(
      {
        type: 'HL_CONNECT_WALLET_RESPONSE',
        id: 'connect-replay-2',
        nonce: noncePayload.nonce,
        error: 'Bridge nonce replay detected',
      },
      '*',
    );
  });

  it('rejects stale nonces before provider call', async () => {
    const request = vi.fn().mockResolvedValue(['0xabc']);
    // @ts-ignore
    window.ethereum = { request };

    await initBridgeToken();

    await messageHandler!({
      source: window,
      data: {
        type: 'HL_CONNECT_WALLET_REQUEST',
        id: 'connect-stale',
        authToken,
        ...createNoncePayload({
          requestTsMs: Date.now() - 60_000,
          nonceExpiresAtMs: Date.now() - 30_000,
        }),
      },
    } as any);

    expect(request).not.toHaveBeenCalled();
    expect(window.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'HL_CONNECT_WALLET_RESPONSE',
        id: 'connect-stale',
        error: 'Bridge nonce expired',
      }),
      '*',
    );
  });
});
