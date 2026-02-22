#!/usr/bin/env node
/*
 Seed a test message into the local nwaku node via LightPush.

 Usage:
   node scripts/waku-seed.js \
     --peer-id <peerId> [--uri localhost] [--ws-port 8000] \
     [--bootstrap-peers '<multiaddr>,<multiaddr>'] \
     [--topic /hl-chat/1/TEST-INTEGRATION_Perps/proto] [--cluster 999] [--shard 0] \
     [--num-shards 1024]

Reads defaults from .env:
   VITE_WAKU_BOOTSTRAP_PEERS, VITE_WAKU_NODE_URI, VITE_WAKU_NODE_PORT, VITE_WAKU_NODE_PEER_ID
*/

const path = require('node:path');
const { pathToFileURL } = require('node:url');
require('dotenv').config();

// Minimal polyfills for js-waku in Node
global.crypto = require('node:crypto').webcrypto;
global.WebSocket = require('ws');
const { TextEncoder } = require('node:util');

// Minimal navigator for js-waku userAgent code paths
if (!global.navigator) {
  // @ts-ignore
  global.navigator = { userAgent: `node/${process.version}` };
}

// js-waku/libp2p expect CustomEvent to exist (Web API). Provide a minimal shim.
if (typeof global.CustomEvent === 'undefined') {
  global.CustomEvent = class CustomEvent extends Event {
    constructor(type, params = {}) {
      super(type, params);
      this.detail = params.detail ?? null;
    }
  };
}

// Polyfill Promise.withResolvers for Node < 22
if (typeof Promise.withResolvers !== 'function') {
  // @ts-ignore
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const n = args[i + 1];
    if (a === '--peer-id') out.peerId = n, i++;
    else if (a === '--uri') out.uri = n, i++;
    else if (a === '--ws-port') out.port = Number(n), i++;
    else if (a === '--topic') out.topic = n, i++;
    else if (a === '--cluster') out.cluster = Number(n), i++;
    else if (a === '--shard') out.shard = Number(n), i++;
    else if (a === '--num-shards') out.numShards = Number(n), i++;
    else if (a === '--bootstrap-peers') out.bootstrapPeers = n, i++;
  }
  return out;
}

function formatAttemptFailures(attemptFailures) {
  if (!attemptFailures.length) return '(none)';
  return attemptFailures.map((item) => `${item.peer} (${item.reason})`).join('; ');
}

(async () => {
  const args = parseArgs();
  const uri = args.uri || process.env.VITE_WAKU_NODE_URI || 'localhost';
  const port = args.port || Number(process.env.VITE_WAKU_NODE_PORT || 8000);
  const peerId = args.peerId || process.env.VITE_WAKU_NODE_PEER_ID;
  const cluster = args.cluster ?? 999;
  const shard = args.shard ?? 0;
  const envNumShards = process.env.WAKU_NUM_SHARDS || process.env.VITE_WAKU_NUM_SHARDS;
  const numShards = args.numShards ?? (envNumShards ? Number(envNumShards) : undefined);
  const topic = args.topic || '/hl-chat/1/TEST-INTEGRATION_Perps/proto';
  const bootstrapPeersRaw = args.bootstrapPeers ?? process.env.VITE_WAKU_BOOTSTRAP_PEERS ?? '';

  const bootstrapConfigPath = pathToFileURL(path.join(__dirname, '..', 'lib', 'bootstrap-peer-config.js')).href;
  const {
    buildLegacyBootstrapPeerFromHost,
    parseBootstrapPeerList,
  } = await import(bootstrapConfigPath);

  let bootstrapPeers = [];
  if (String(bootstrapPeersRaw).trim()) {
    bootstrapPeers = parseBootstrapPeerList(bootstrapPeersRaw, {
      contextLabel: 'nwaku-seed bootstrap peers',
    });
  } else {
    if (!peerId) {
      console.error('Missing peer id. Pass --peer-id or set VITE_WAKU_NODE_PEER_ID.');
      process.exit(2);
    }
    bootstrapPeers = [buildLegacyBootstrapPeerFromHost({
      contextLabel: 'nwaku-seed legacy bootstrap peer',
      host: uri,
      port,
      peerId,
    })];
  }
  const pubsub = `/waku/2/rs/${cluster}/${shard}`;

  const wakuPath = pathToFileURL(path.join(__dirname, '..', 'lib', 'js-waku.min.js')).href;
  const { createLightNode, waitForRemotePeer, Protocols } = await import(wakuPath);

  console.log('Configured bootstrap peers:');
  bootstrapPeers.forEach((peer, index) => {
    console.log(`  [${index + 1}] ${peer.multiaddr}`);
  });

  const networkConfig = typeof numShards === 'number'
    ? { clusterId: cluster, numShardsInCluster: numShards }
    : { clusterId: cluster };
  const attemptFailures = [];

  for (let index = 0; index < bootstrapPeers.length; index += 1) {
    const peer = bootstrapPeers[index];
    console.log(`Attempt ${index + 1}/${bootstrapPeers.length}: ${peer.multiaddr}`);
    let node;
    try {
      node = await createLightNode({
        defaultBootstrap: false,
        bootstrapPeers: [peer.multiaddr],
        pubsubTopics: [pubsub],
        shardInfo: { clusterId: cluster, shards: [shard] },
        networkConfig,
        libp2p: peer.isLocalHost
          ? { filterMultiaddrs: false, hideWebSocketInfo: true }
          : { hideWebSocketInfo: true },
        // Explicitly configure service peers to avoid discovery delays in isolated clusters.
        store: { peers: [peer.multiaddr] },
        filter: { peers: [peer.multiaddr] },
        lightPush: { peers: [peer.multiaddr] },
      });

      await node.start();
      console.log('Waiting for LightPush peer...');
      await waitForRemotePeer(node, [Protocols.LightPush], 45000);

      const encoder = node.createEncoder({ contentTopic: topic, shardId: shard });
      const payload = new TextEncoder().encode(JSON.stringify({ kind: 'seed', ts: Date.now() }));
      const pushResult = await node.lightPush.send(encoder, { payload, timestamp: new Date() });
      if (!pushResult?.successes?.length) {
        const failure = (pushResult?.failures || [])[0];
        const reason = failure?.error || 'unknown_error';
        const failedPeer = failure?.peerId ? ` (peer ${failure.peerId.toString()})` : '';
        throw new Error(`LightPush failed: ${reason}${failedPeer}. Check nwaku logs for detail.`);
      }

      console.log(`Selected bootstrap peer: ${peer.multiaddr}`);
      if (attemptFailures.length > 0) {
        console.log(`Previous failed peers: ${formatAttemptFailures(attemptFailures)}`);
      }
      console.log('Seed message pushed to Waku');
      await node.stop();
      process.exit(0);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attemptFailures.push({ peer: peer.multiaddr, reason });
      console.warn(`Bootstrap attempt failed for ${peer.multiaddr}: ${reason}`);
      if (node) {
        try {
          await node.stop();
        } catch {
          // ignore teardown errors when trying next peer
        }
      }
    }
  }

  throw new Error(`No bootstrap peers succeeded. Failures: ${formatAttemptFailures(attemptFailures)}`);
})().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
