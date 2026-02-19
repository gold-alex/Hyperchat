import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Wallet Bridge (Vitest)', () => {
  let messageHandler: ((e: MessageEvent) => void) | undefined;
  const authToken = 'bridge-auth-token-12345';

  beforeEach(async () => {
    vi.clearAllMocks();

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
      data: { type: 'HL_CONNECT_WALLET_REQUEST', id: 'connect-1' },
    } as any);

    expect((window as any).ethereum.request).not.toHaveBeenCalled();
    expect(window.postMessage).toHaveBeenCalledWith(
      { type: 'HL_CONNECT_WALLET_RESPONSE', id: 'connect-1', error: 'Bridge authentication failed' },
      '*',
    );
  });

  it('getProvider: returns error when no wallet present after auth', async () => {
    await initBridgeToken();

    await messageHandler!({
      source: window,
      data: { type: 'HL_CONNECT_WALLET_REQUEST', id: 'connect-2', authToken },
    } as any);

    expect(window.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'HL_CONNECT_WALLET_RESPONSE',
        id: 'connect-2',
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
    await initBridgeToken();

    await messageHandler!({
      source: window,
      data: { type: 'HL_CONNECT_WALLET_REQUEST', id: 'connect-3', authToken },
    } as any);

    // @ts-ignore
    expect(window.ethereum.providers[1].request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
    expect(window.postMessage).toHaveBeenCalledWith(
      { type: 'HL_CONNECT_WALLET_RESPONSE', id: 'connect-3', accounts: ['0xrabby'] },
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

    await initBridgeToken();

    await messageHandler!({
      source: window,
      data: { type: 'HL_SIGN_REQUEST', id: 'sign-1', message: 'Hello', address: '0xabc', authToken },
    } as any);

    expect(request).toHaveBeenNthCalledWith(1, { method: 'eth_accounts' });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: 'personal_sign',
      params: ['Hello', '0xabc'],
    });
    expect(window.postMessage).toHaveBeenCalledWith(
      { type: 'HL_SIGN_RESPONSE', id: 'sign-1', signature: '0xsignature' },
      '*',
    );
  });
});
