import { describe, expect, it } from 'vitest';

async function loadClientClass() {
  const module = await import('../lib/waku-chat-client.js');
  return module.WakuChatClient;
}

describe('WakuChatClient transport policy', () => {
  it('rejects non-local http gateway URLs in strict mode', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({ gatewayUrl: 'http://gateway.example.com' });

    let thrown: any;
    try {
      client._assertGatewayConfigured('session establishment');
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('GATEWAY_INSECURE_TRANSPORT');
    expect(thrown?.message).toMatch(/Use https:\/\//);
  });

  it('accepts localhost http gateway URL for local development', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({ gatewayUrl: 'http://localhost:8787' });

    expect(() => client._assertGatewayConfigured('session establishment')).not.toThrow();
  });

  it('accepts https gateway URL for non-local hosts', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({ gatewayUrl: 'https://gateway.example.com' });

    expect(() => client._assertGatewayConfigured('session establishment')).not.toThrow();
  });

  it('rejects remote ws endpoint configuration for Waku node', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({ wakuNodeURI: 'ws://nwaku.example.com' });

    let thrown: any;
    try {
      client._resolveWakuTransport();
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('WAKU_INSECURE_TRANSPORT');
    expect(thrown?.message).toMatch(/Insecure Waku transport "ws" is not allowed/);
  });

  it('keeps local ws compatibility for localhost Waku node', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({ wakuNodeURI: 'ws://localhost:8000' });

    expect(client._resolveWakuTransport()).toMatchObject({ isLocal: true, wsProto: 'ws' });
  });

  it('uses wss transport for non-local host-only Waku configuration', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({ wakuNodeURI: 'nwaku.example.com' });

    expect(client._resolveWakuTransport()).toMatchObject({ isLocal: false, wsProto: 'wss' });
  });
});
