import { describe, expect, it, vi } from 'vitest';

import { __gatewayTestUtils } from '../src/waku/gateway/server';
import { createGatewayServer } from '../src/waku/gateway/server';

describe('gateway lightpush bootstrap peerlist', () => {
  it('resolves configured bootstrap list before legacy peer vars', () => {
    const peers = __gatewayTestUtils.resolveGatewayLightpushBootstrapPeers({
      rpcUrl: 'http://127.0.0.1:8645',
      lightpushBootstrapPeers: '/dns4/nwaku-a.example.com/tcp/443/wss/p2p/16Uiu2HAmListWins',
      lightpushPeerId: '16Uiu2HAmLegacy',
      lightpushWsUrl: 'wss://legacy.example.com:443',
    });

    expect(peers).toHaveLength(1);
    expect(peers[0].peerId).toBe('16Uiu2HAmListWins');
  });

  it('fails over deterministically across bootstrap peers', async () => {
    const callOrder: string[] = [];
    const createLightpushPublisher = __gatewayTestUtils.createLightpushPublisher as any;
    const publisher = createLightpushPublisher({
      peers: [
        {
          multiaddr: '/dns4/nwaku-a.local/tcp/8000/ws/p2p/16Uiu2HAmA',
          wsUrl: 'ws://nwaku-a.local:8000',
          peerId: '16Uiu2HAmA',
          isLocalHost: true,
        },
        {
          multiaddr: '/dns4/nwaku-b.local/tcp/8000/ws/p2p/16Uiu2HAmB',
          wsUrl: 'ws://nwaku-b.local:8000',
          peerId: '16Uiu2HAmB',
          isLocalHost: true,
        },
      ],
      contextFactory: async (peer: any) => {
        const send = vi.fn(async () => {
          callOrder.push(peer.peerId);
          if (peer.peerId === '16Uiu2HAmA') {
            throw new Error('peer A unavailable');
          }
          return { successes: [{}], failures: [] };
        });
        return {
          node: {
            stop: vi.fn(async () => undefined),
            createEncoder: vi.fn(() => ({ peerId: peer.peerId })),
            lightPush: { send },
          },
          waitForRemotePeer: vi.fn(async () => undefined),
          protocols: { LightPush: 'lightpush' },
          connectedPubsubTopics: new Set<string>(),
        };
      },
    });

    const result = await publisher({
      payloadBase64: Buffer.from('hello').toString('base64'),
      contentTopic: '/waku-auth-lite/1/chat/json',
      pubsubTopic: '/waku/2/rs/999/0',
    });

    expect(result.transport).toBe('lightpush');
    expect(callOrder).toEqual(['16Uiu2HAmA', '16Uiu2HAmB']);
  });

  it('rejects insecure non-local ws entries at startup', () => {
    expect(() =>
      createGatewayServer({
        rpcUrl: 'http://127.0.0.1:8645',
        expectedDomain: 'gateway.local',
        expectedChainId: 1,
        publishTransport: 'lightpush',
        lightpushBootstrapPeers: '/dns4/relay.example.com/tcp/8000/ws/p2p/16Uiu2HAmBad',
      }),
    ).toThrow(/insecure websocket transport/i);
  });
});
