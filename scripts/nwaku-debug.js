#!/usr/bin/env node
/*
 Diagnostic utility for local nwaku node.
 - Summarizes node info, peers, and protocol support (Store/Filter/LightPush)
 - Optionally queries Store REST for a content topic
 - Attempts a DB summary via the sqlite sidecar (docker-compose)

 Usage:
   node scripts/nwaku-diagnose.js [--uri localhost] [--port 8645] \
     [--topic /hl-chat/1/BTC-USD_Perps/proto] [--pubsub /waku/2/rs/999/0]

 Reads defaults from .env: VITE_WAKU_NODE_URI, VITE_WAKU_NODE_PORT, VITE_WAKU_NODE_PEER_ID
*/

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config();

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const n = args[i + 1];
    if (a === '--uri') out.uri = n, i++;
    else if (a === '--port') out.restPort = Number(n), i++; // legacy alias
    else if (a === '--rest-port') out.restPort = Number(n), i++;
    else if (a === '--ws-port') out.wsPort = Number(n), i++;
    else if (a === '--topic') out.topic = n, i++;
    else if (a === '--pubsub') out.pubsub = n, i++;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

function tryDockerComposeSql(query) {
  // Runs sqlite sidecar to query the DB; expects docker-compose.yml in ./docker
  const dockerDir = path.join(__dirname, '..', 'docker');
  const cmd = `docker-compose run --rm sqlite /db/waku_messages.db "${query.replace(/"/g, '""')}"`;
  const res = spawnSync('bash', ['-lc', cmd], { cwd: dockerDir, encoding: 'utf8' });
  if (res.status === 0) {
    return res.stdout.trim();
  }
  return { error: res.stderr.trim() || 'Failed to run sqlite sidecar' };
}

function tryDockerSqlViaHostVolume(query) {
  // Detect host dir mounted to /var/db in nwaku-node
  const inspect = spawnSync('bash', ['-lc', "docker inspect -f '{{range .Mounts}}{{if eq .Destination \"/var/db\"}}{{.Source}}{{end}}{{end}}' nwaku-node"], { encoding: 'utf8' });
  const source = (inspect.stdout || '').trim();
  if (!source) return { error: 'Could not detect host DB dir from nwaku-node mounts' };
  const safeQuery = query.replace(/"/g, '""');
  const tryImages = ['sqlite-cli:alpine', 'nouchka/sqlite3'];
  for (const image of tryImages) {
    const cmd = `docker run --rm -v "${source}":/db ${image} sqlite3 /db/waku_messages.db "${safeQuery}"`;
    const res = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8' });
    if (res.status === 0) return res.stdout.trim();
  }
  return { error: 'Failed to run docker sqlite against host volume' };
}

function prettyPrint(title, obj) {
  console.log(`\n=== ${title} ===`);
  if (typeof obj === 'string') console.log(obj);
  else console.log(JSON.stringify(obj, null, 2));
}

(async () => {
  const args = parseArgs();
  if (args.help) {
    console.log(`Usage: node scripts/nwaku-diagnose.js [--uri localhost] [--port 8645] [--topic /hl-chat/1/BTC-USD_Perps/proto] [--pubsub /waku/2/rs/999/0]`);
    process.exit(0);
  }

  const uri = args.uri || process.env.VITE_WAKU_NODE_URI || 'localhost';
  const restPort = args.restPort || Number(process.env.WAKU_REST_PORT || 8645);
  const wsPort = args.wsPort || Number(process.env.VITE_WAKU_NODE_PORT || 8000);
  const peerId = process.env.VITE_WAKU_NODE_PEER_ID || '';
  const topic = args.topic || '/hl-chat/1/TEST-INTEGRATION_Perps/proto';
  const pubsub = args.pubsub || '/waku/2/rs/999/0';

  console.log('Nwaku Diagnose');
  console.log(`- REST base:   http://${uri}:${restPort}`);
  console.log(`- Peer ID:     ${peerId || '(unset)'}`);
  console.log(`- Topic:       ${topic}`);
  console.log(`- PubSub:      ${pubsub}`);
  console.log(`- WS addr:     ws://${uri}:${wsPort}`);

  // 1) Node info
  try {
    const info = await fetchJson(`http://${uri}:${restPort}/debug/v1/info`);
    prettyPrint('Node Info', {
      enrUri: info.enrUri,
      listenAddresses: info.listenAddresses,
      pubsubTopic: pubsub,
    });
  } catch (e) {
    prettyPrint('Node Info', { error: String(e) });
  }

  // 2) Peers + protocol support summary
  try {
    const peers = await fetchJson(`http://${uri}:${restPort}/admin/v1/peers`);
    const total = peers.length;
    const withFilter = peers.filter(p => (p.protocols || []).some(x => x.startsWith('/vac/waku/filter'))).length;
    const withStore = peers.filter(p => (p.protocols || []).some(x => x.startsWith('/vac/waku/store'))).length;
    const withLightPush = peers.filter(p => (p.protocols || []).some(x => x.startsWith('/vac/waku/lightpush'))).length;
    prettyPrint('Peers Summary', { total, withFilter, withStore, withLightPush });

    // Show first few peers and their protocols
    const sample = peers.slice(0, 8).map(p => ({ id: p.id, protocols: p.protocols, addrs: (p.addresses || []).map(a => a.multiaddr) }));
    prettyPrint('Peers Sample', sample);
  } catch (e) {
    const msg = String(e);
    if (/HTTP 404/.test(msg)) {
      prettyPrint('Peers Summary', { error: msg, hint: 'Admin REST endpoints likely disabled. Add --rest-admin=true to nwaku command flags.' });
    } else {
      prettyPrint('Peers Summary', { error: msg });
    }
  }

  // 3) Store REST query for the topic (12h window is default server-side)
  try {
    const url = `http://${uri}:${restPort}/store/v3/messages?contentTopics=${encodeURIComponent(topic)}&pubsubTopic=${encodeURIComponent(pubsub)}`;
    const res = await fetchJson(url);
    prettyPrint('Store REST (current topic)', { count: (res.messages || []).length });
  } catch (e) {
    prettyPrint('Store REST (current topic)', { error: String(e) });
  }

  // 4) WebSocket connectivity check
  try {
    const WebSocket = require('ws');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${uri}:${wsPort}`);
      const timer = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error('WebSocket connect timeout')); }, 4000);
      ws.on('open', () => { clearTimeout(timer); ws.close(); resolve(null); });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    prettyPrint('WebSocket', 'ws connect ok');
  } catch (e) {
    prettyPrint('WebSocket', { error: String(e) });
  }

  // 5) DB summary from sqlite (optional)
  try {
    const candidateDirs = [
      process.env.WAKU_DB_PATH,
      path.join(__dirname, '..', 'nwaku_test_db'),
      path.join(__dirname, '..', 'nwaku_db'),
      './nwaku_test_db',
      './docker/nwaku_test_db',
      './nwaku_db',
      './docker/nwaku_db',
    ].filter(Boolean);
    let dbDir = candidateDirs.find((dir) =>
      fs.existsSync(path.resolve(path.join(dir, 'waku_messages.db')))
    ) || candidateDirs[0] || './nwaku_db';

    const dbFile = path.resolve(path.join(dbDir, 'waku_messages.db'));
    // nwaku stores messages in the `message` table (singular)
    const sql = 'SELECT contentTopic, COUNT(*) as n FROM message GROUP BY contentTopic ORDER BY n DESC LIMIT 10;';
    let out;

    // First, try a direct sqlite3 via docker run against the resolved path
    const sqliteCmd = `docker run --rm -v "${path.dirname(dbFile)}":/db nouchka/sqlite3 /db/waku_messages.db "${sql.replace(/"/g, '""')}"`;
    const direct = spawnSync('bash', ['-lc', sqliteCmd], { encoding: 'utf8' });
    if (direct.status === 0) {
      out = direct.stdout.trim();
    } else {
      // fall back to legacy helpers
      out = tryDockerSqlViaHostVolume(sql);
      if (typeof out === 'object' && out.error) {
        out = tryDockerComposeSql(sql);
      }
    }

    if (typeof out === 'string' && out.trim() === '') {
      out = '0 rows';
    }
    prettyPrint('DB Summary (sqlite sidecar)', {
      dbPath: dbFile,
      result: out
    });
  } catch (e) {
    prettyPrint('DB Summary (sqlite sidecar)', { error: String(e) });
  }
})();
