#!/usr/bin/env node
/*
 Seed a test message into the local nwaku node via LightPush.

 Usage:
   node scripts/waku-seed.js \
     --peer-id <peerId> [--uri localhost] [--ws-port 8000] \
     [--topic /hl-chat/1/TEST-INTEGRATION_Perps/proto] [--cluster 999] [--shard 0] \
     [--num-shards 1024]

 Reads defaults from .env:
   VITE_WAKU_NODE_URI, VITE_WAKU_NODE_PORT, VITE_WAKU_NODE_PEER_ID
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
  }
  return out;
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

  if (!peerId) {
    console.error('Missing peer id. Pass --peer-id or set VITE_WAKU_NODE_PEER_ID.');
    process.exit(2);
  }

  const wsProto = ['localhost', '127.0.0.1'].includes(String(uri).toLowerCase()) ? 'ws' : 'wss';
  const remoteMaStr = `/dns4/${uri}/tcp/${port}/${wsProto}/p2p/${peerId}`;
  const pubsub = `/waku/2/rs/${cluster}/${shard}`;

  const wakuPath = pathToFileURL(path.join(__dirname, '..', 'lib', 'js-waku.min.js')).href;
  const { createLightNode, waitForRemotePeer, Protocols } = await import(wakuPath);

  console.log('Connecting to nwaku via:', remoteMaStr);
  const networkConfig = typeof numShards === 'number'
    ? { clusterId: cluster, numShardsInCluster: numShards }
    : { clusterId: cluster };

  const node = await createLightNode({
    defaultBootstrap: false,
    bootstrapPeers: [remoteMaStr],
    pubsubTopics: [pubsub],
    shardInfo: { clusterId: cluster, shards: [shard] },
    networkConfig,
    libp2p: { filterMultiaddrs: false },
    // Explicitly configure service peers to avoid discovery delays in isolated clusters
    store: { peers: [remoteMaStr] },
    filter: { peers: [remoteMaStr] },
    lightPush: { peers: [remoteMaStr] },
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
    const peer = failure?.peerId ? ` (peer ${failure.peerId.toString()})` : '';
    throw new Error(`LightPush failed: ${reason}${peer}. Check nwaku logs for detail.`);
  }
  console.log('Seed message pushed to Waku');

  await node.stop();
  process.exit(0);
})().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
