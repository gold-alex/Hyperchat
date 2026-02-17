import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

vi.mock('viem', () => ({
  verifyMessage: vi.fn(),
}));

const { verifyMessage } = await import('viem');
const { Hyperchat } = await import('../src/hyperchat.js');

const buildApi = () => ({
  runtime: {
    sendMessage: vi.fn((payload, cb) => {
      if (cb) cb({ ok: true, payload });
      return { ok: true, payload };
    }),
    getURL: (path) => `chrome-extension://test/${path}`,
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  storage: {
    local: {
      get: vi.fn((_keys, cb) => cb && cb({})),
      set: vi.fn((_data, cb) => cb && cb()),
    },
  },
});

describe('Hyperchat UI + wallet flows', () => {
  let chat;
  let api;

  beforeEach(() => {
    document.body.innerHTML = '';
    window.DISABLE_WALLET_BRIDGE = true;
    window.IS_STANDALONE_CHAT = false;
    api = buildApi();
    chat = new Hyperchat({ extensionAPI: api });
    chat.currentPair = 'TEST';
    chat.currentMarket = 'Perps';
  });

  it('creates, toggles, and hides the chat widget', () => {
    chat.showChatDirect();
    const widget = document.getElementById('hyperliquid-chat-widget');
    const container = widget?.querySelector('.hl-chat-container');
    expect(widget).not.toBeNull();
    expect(container?.classList.contains('visible')).toBe(true);

    chat.toggleChat();
    expect(container?.classList.contains('visible')).toBe(false);

    chat.toggleChat();
    expect(container?.classList.contains('visible')).toBe(true);

    chat.hideChat();
    expect(document.getElementById('hyperliquid-chat-widget')).toBeNull();
  });

  it('sends a message via Waku and updates UI', async () => {
    chat.walletAddress = '0xabc';
    chat.selectedName = 'tester.hl';
    chat.wakuClient = {
      setRoom: vi.fn(),
      setWalletInfo: vi.fn(),
      sendMessage: vi.fn(async (content) => ({
        timestamp: Date.now(),
        address: chat.walletAddress,
        content,
        name: chat.selectedName,
      })),
    };

    chat.createChatWidget();
    const input = document.getElementById('messageInput');
    input.value = 'hello world';

    await chat.sendMessageViaWaku();

    expect(chat.wakuClient.sendMessage).toHaveBeenCalledWith('hello world');
    expect(chat.messages.length).toBe(1);
    expect(input.value).toBe('');
    const container = document.getElementById('chatMessages');
    expect(container?.innerHTML).toContain('hello world');
  });

  it('blocks send when wallet is missing', async () => {
    chat.wakuClient = {
      setRoom: vi.fn(),
      setWalletInfo: vi.fn(),
      sendMessage: vi.fn(),
    };
    document.body.innerHTML = `
      <div id="chatMessages"></div>
      <input id="messageInput" />
    `;
    document.getElementById('messageInput').value = 'no wallet';
    const showError = vi.spyOn(chat, 'showError').mockImplementation(() => {});

    await chat.sendMessageViaWaku();

    expect(showError).toHaveBeenCalledWith('Connect wallet first.');
    expect(chat.wakuClient.sendMessage).not.toHaveBeenCalled();
  });

  it('requestAccounts resolves when response message is posted', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const cleanup = (event) => {
      if (event.data?.type !== 'HL_CONNECT_WALLET_REQUEST') return;
      const response = new MessageEvent('message', {
        data: { type: 'HL_CONNECT_WALLET_RESPONSE', id: event.data.id, accounts: ['0xabc'] },
        source: window,
      });
      window.dispatchEvent(response);
    };
    window.addEventListener('message', cleanup);

    const accounts = await chat.requestAccounts();

    expect(accounts).toEqual(['0xabc']);
    window.removeEventListener('message', cleanup);
    randomSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it('signMessage resolves with signature response', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.2);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2000);
    chat.walletAddress = '0xabc';
    const cleanup = (event) => {
      if (event.data?.type !== 'HL_SIGN_REQUEST') return;
      const response = new MessageEvent('message', {
        data: { type: 'HL_SIGN_RESPONSE', id: event.data.id, signature: '0xsig' },
        source: window,
      });
      window.dispatchEvent(response);
    };
    window.addEventListener('message', cleanup);

    const signature = await chat.signMessage('hello');

    expect(signature).toBe('0xsig');
    window.removeEventListener('message', cleanup);
    randomSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it('authenticateWallet succeeds when signature verifies', async () => {
    chat.walletAddress = '0xabc';
    vi.spyOn(chat, 'signMessage').mockResolvedValue('0xsig');
    verifyMessage.mockResolvedValue(true);

    const result = await chat.authenticateWallet();

    expect(result.signature).toBe('0xsig');
    expect(result.timestamp).toBeTypeOf('number');
  });

  it('authenticateWallet throws on failed verification', async () => {
    chat.walletAddress = '0xabc';
    vi.spyOn(chat, 'signMessage').mockResolvedValue('0xsig');
    verifyMessage.mockResolvedValue(false);

    await expect(chat.authenticateWallet()).rejects.toThrow('Signature verification failed');
  });

  it('connectWallet persists wallet state and notifies background', async () => {
    const address = '0xabc';
    vi.spyOn(chat, 'requestAccounts').mockResolvedValue([address]);
    vi.spyOn(chat, 'authenticateWallet').mockResolvedValue({ signature: '0xsig', timestamp: Date.now() });
    vi.spyOn(chat, 'fetchHLNames').mockResolvedValue(['tester.hl']);

    await chat.connectWallet();

    expect(chat.walletAddress).toBe(address);
    expect(chat.selectedName).toBe('tester.hl');
    expect(api.storage.local.set).toHaveBeenCalled();
    expect(api.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'walletConnected', walletAddress: address }),
      expect.any(Function),
    );
  });

  it('connectWallet clears state on failed authentication', async () => {
    vi.spyOn(chat, 'requestAccounts').mockResolvedValue(['0xabc']);
    vi.spyOn(chat, 'authenticateWallet').mockRejectedValue(new Error('bad sig'));
    const notifyUser = vi.spyOn(chat, 'notifyUser').mockImplementation(() => {});

    await chat.connectWallet();

    expect(chat.walletAddress).toBe('');
    expect(notifyUser).toHaveBeenCalledWith('Signature verification failed. Check console.');
  });

  it('restores wallet connection from storage', async () => {
    api.storage.local.get.mockImplementation((_keys, cb) => {
      cb({
        walletConnected: true,
        walletAddress: '0xdef',
        availableNames: ['alpha.hl'],
        selectedName: 'alpha.hl',
      });
    });

    await chat.restoreWalletConnection();

    expect(chat.walletAddress).toBe('0xdef');
    expect(chat.selectedName).toBe('alpha.hl');
    expect(chat.availableNames).toEqual(['alpha.hl']);
  });
});
