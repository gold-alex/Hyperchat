import { describe, expect, it } from 'vitest';

import {
  buildLegacyBootstrapPeerFromHost,
  buildLegacyBootstrapPeerFromWsUrl,
  parseBootstrapPeerList,
} from '../lib/bootstrap-peer-config.js';

describe('bootstrap peer config', () => {
  it('parses and de-duplicates ordered multiaddr peer lists', () => {
    const peers = parseBootstrapPeerList(
      [
        '/dns4/nwaku-a.internal/tcp/8000/ws/p2p/16Uiu2HAmA123',
        '/dns4/nwaku-a.internal/tcp/8000/ws/p2p/16Uiu2HAmA123',
        '/dns4/nwaku-b.example.com/tcp/443/wss/p2p/16Uiu2HAmB456',
      ],
      { contextLabel: 'test peer list' },
    );

    expect(peers).toHaveLength(2);
    expect(peers[0].multiaddr).toContain('/dns4/nwaku-a.internal/tcp/8000/ws/p2p/16Uiu2HAmA123');
    expect(peers[1].multiaddr).toContain('/dns4/nwaku-b.example.com/tcp/443/wss/p2p/16Uiu2HAmB456');
  });

  it('rejects insecure remote ws entries', () => {
    expect(() =>
      parseBootstrapPeerList('/dns4/nwaku.example.com/tcp/8000/ws/p2p/16Uiu2HAmBadWs', {
        contextLabel: 'test peer list',
      }),
    ).toThrow(/insecure websocket transport/i);
  });

  it('rejects malformed entries with actionable message', () => {
    expect(() =>
      parseBootstrapPeerList('/dns4/no-peer-id/tcp/8000/ws', {
        contextLabel: 'test peer list',
      }),
    ).toThrow(/Expected multiaddr/i);
  });

  it('enforces maximum bootstrap peer count', () => {
    expect(() =>
      parseBootstrapPeerList(
        [
          '/dns4/a.local/tcp/8000/ws/p2p/16Uiu2HAmA111',
          '/dns4/b.local/tcp/8000/ws/p2p/16Uiu2HAmB222',
        ],
        { contextLabel: 'test peer list', maxEntries: 1 },
      ),
    ).toThrow(/max supported is 1/i);
  });

  it('builds secure legacy peer from host fallback', () => {
    const peer = buildLegacyBootstrapPeerFromHost({
      contextLabel: 'legacy fallback',
      host: 'nwaku.example.com',
      port: 443,
      peerId: '16Uiu2HAmLegacy123',
    });

    expect(peer.multiaddr).toContain('/dns4/nwaku.example.com/tcp/443/wss/p2p/16Uiu2HAmLegacy123');
  });

  it('builds local ws legacy peer from websocket URL', () => {
    const peer = buildLegacyBootstrapPeerFromWsUrl({
      contextLabel: 'legacy ws fallback',
      wsUrl: 'ws://localhost:8000',
      peerId: '16Uiu2HAmLegacyWs',
    });

    expect(peer.multiaddr).toContain('/dns4/localhost/tcp/8000/ws/p2p/16Uiu2HAmLegacyWs');
    expect(peer.wsUrl).toBe('ws://localhost:8000');
  });
});
