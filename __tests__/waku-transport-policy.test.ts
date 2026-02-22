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

  it('uses bootstrap peer list in preference to legacy single-peer env', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({
      wakuNodeURI: 'legacy.example.com',
      wakuNodePort: 443,
      wakuNodePeerId: '16Uiu2HAmLegacy',
      wakuBootstrapPeers: '/dns4/nwaku-a.example.com/tcp/443/wss/p2p/16Uiu2HAmListA',
    });

    const peers = client._resolveBootstrapPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0].peerId).toBe('16Uiu2HAmListA');
  });

  it('rejects insecure non-local ws bootstrap list entries', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({
      wakuBootstrapPeers: '/dns4/nwaku.example.com/tcp/8000/ws/p2p/16Uiu2HAmBad',
    });

    let thrown: any;
    try {
      client._resolveBootstrapPeers();
    } catch (error) {
      thrown = error;
    }

    expect(thrown?.code).toBe('BOOTSTRAP_PEERLIST_INVALID');
    expect(thrown?.message).toMatch(/insecure websocket transport/i);
  });

  it('keeps ws compatibility for single-label local bootstrap hosts', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({
      wakuBootstrapPeers: '/dns4/nwaku/tcp/8000/ws/p2p/16Uiu2HAmDockerLocal',
    });

    const peers = client._resolveBootstrapPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0].transport).toBe('ws');
  });
});
