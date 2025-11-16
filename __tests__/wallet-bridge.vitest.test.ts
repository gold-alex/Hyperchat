import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Wallet Bridge (Vitest)', () => {
  // Captured message handler from the bridge
  let messageHandler: ((e: MessageEvent) => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset window.ethereum and postMessage
    // @ts-ignore - test shim
    window.ethereum = undefined;
    // @ts-ignore - test shim
    window.postMessage = vi.fn();

    // Capture the message listener the bridge installs
    const originalAddEventListener = window.addEventListener;
    // @ts-ignore
    window.addEventListener = vi.fn((event: string, handler: any) => {
      if (event === 'message') messageHandler = handler;
    });

    // Dynamically load the bridge (IIFE) so it registers listeners
    await import('../public/wallet-bridge.js');

    // Restore addEventListener for any non-message listeners
    window.addEventListener = originalAddEventListener;
  });

  it('getProvider: returns error when no wallet present', async () => {
    const evt = { source: window, data: { type: 'HL_CONNECT_WALLET_REQUEST', id: 'test-id' } } as any;
    await messageHandler!(evt);
    expect(window.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'HL_CONNECT_WALLET_RESPONSE', id: 'test-id', error: expect.stringContaining('No Ethereum wallet') }),
      '*',
    );
  });

  it('prefers Rabby over MetaMask', async () => {
    // @ts-ignore
    window.ethereum = {
      providers: [
        { isMetaMask: true, request: vi.fn().mockResolvedValue(['0xmetamask']) },
        { isRabby: true, request: vi.fn().mockResolvedValue(['0xrabby']) },
      ],
    };
    const evt = { source: window, data: { type: 'HL_CONNECT_WALLET_REQUEST', id: 'id-1' } } as any;
    await messageHandler!(evt);
    // @ts-ignore
    expect(window.ethereum.providers[1].request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
    expect(window.postMessage).toHaveBeenCalledWith({ type: 'HL_CONNECT_WALLET_RESPONSE', id: 'id-1', accounts: ['0xrabby'] }, '*');
  });

  it('handles HL_SIGN_REQUEST and posts signature', async () => {
    // @ts-ignore
    window.ethereum = { request: vi.fn().mockResolvedValue('0xsignature') };
    const evt = { source: window, data: { type: 'HL_SIGN_REQUEST', id: 'sign-1', message: 'Hello', address: '0xabc' } } as any;
    await messageHandler!(evt);
    expect(window.postMessage).toHaveBeenCalledWith({ type: 'HL_SIGN_RESPONSE', id: 'sign-1', signature: '0xsignature' }, '*');
  });
});

