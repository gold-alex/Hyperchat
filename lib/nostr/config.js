// HyperChat network configuration.
//
// Everything tunable about how the extension talks to the nostr network and how
// hard it is to get a message rendered lives here. These are the knobs you turn
// when spam shows up, not settings a user ever sees.

// Relays we read from and write to. All of them, simultaneously - this is not a
// failover list. A room survives any subset of these being down or wiped.
//
// Put your own relay first: it is the anchor that never prunes. Override the
// whole list at build time with HYPERCHAT_RELAYS (comma separated).
// Five, not four, because public relays are individually unreliable: damus in
// particular refuses connections intermittently. Expect the panel to sit at 4/5
// rather than 5/5 much of the time - that is the design absorbing a flaky relay,
// not an error. Verified reachable when this list was last revised.
export const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://relay.damus.io',
  'wss://nostr.mom',
]

// Event kinds. 9411 is a regular event (relays store every one); 10411/10412 are
// replaceable (relays keep only the newest per author), which is what we want for
// a wallet binding and a block list.
export const KIND_MESSAGE = 9411
export const KIND_BINDING = 10411
export const KIND_BLOCKLIST = 10412

// Bumping this partitions the network: old clients stop seeing new rooms. Only
// change it for a breaking format change.
export const ROOM_NAMESPACE = 'hyperchat:v1'

// Moderator pubkeys whose block lists every client honours by default. Users can
// switch this off locally; almost nobody will.
export const MODERATOR_PUBKEYS = []

// --- Anti-spam ------------------------------------------------------------
// All four of these are enforced at RENDER time, in every client. Someone who
// reimplements our format can publish whatever they like to a public relay; if
// it fails these checks it does not reach a single screen.

export const SPAM_POLICY = {
  // Author must have actually traded on Hyperliquid. This is the one that costs a
  // spammer real money - keypairs are free, funded HL accounts are not.
  // 'traded'  - has any fill history, or a funded account (default)
  // 'equity'  - account value >= minAccountValueUsd
  // 'name'    - must own a .hl name (strictest; excludes plenty of real traders)
  // 'none'    - wallet binding only (weak; a spammer mints keys for free)
  requires: 'traded',
  minAccountValueUsd: 0,

  // Messages per author per minute, counted as we render. A reimplemented client
  // does not get a vote on what your panel draws.
  maxMessagesPerMinute: 10,

  // Proof of work (NIP-13): leading zero bits required on a message id.
  //
  // Measured at ~450k hashes/sec, so each extra bit doubles the wait: 16 bits is
  // ~0.15s and unnoticeable, 20 bits is ~2.4s and was making sends feel broken.
  // A spammer pushing 10k messages still burns ~25 minutes of CPU at 16.
  // Set to 0 to disable.
  powDifficulty: 16,

  // Give up mining after this long and send without PoW rather than hanging the
  // UI. Such a message will not render for peers enforcing PoW.
  powTimeoutMs: 10000,

  // Messages longer than this are truncated before signing.
  maxMessageLength: 500,

  // Ignore anything claiming to be from further in the future than this, or older
  // than the room history window.
  maxClockSkewSec: 300,
}

// --- Sync behaviour -------------------------------------------------------

export const SYNC = {
  // How much history to pull when opening a room.
  historyLimit: 500,
  historyWindowSec: 7 * 24 * 60 * 60,

  // Events kept per room in IndexedDB. This is the copy of the conversation the
  // user carries around and re-seeds relays from.
  localCapPerRoom: 5000,

  // After the initial sync settles, re-publish events a relay is missing. This is
  // the repair pass - it is how a pruned room heals from whoever walks in next.
  repairEnabled: true,
  repairDelayMs: 3000,
  repairMaxEventsPerRelay: 100,
  repairRatePerSec: 5,

  // Reconnect backoff per relay.
  reconnectBaseMs: 1000,
  reconnectMaxMs: 60000,

  // A relay in a quiet room correctly says nothing for long stretches, so silence
  // alone is not evidence of a dead socket. After this long we ask it a question
  // instead of hanging up on it.
  idleTimeoutMs: 120000,

  // How long that question may go unanswered before we treat the socket as half
  // open and reconnect.
  livenessTimeoutMs: 10000,
}

// Build-time override: HYPERCHAT_RELAYS="wss://mine.example,wss://nos.lol"
// esbuild substitutes the identifier below; under jest it stays undefined and we
// fall back to the defaults.
export function resolveRelays() {
  const configured = typeof __HYPERCHAT_RELAYS__ === 'string' ? __HYPERCHAT_RELAYS__ : ''
  if (!configured) return [...DEFAULT_RELAYS]
  const parsed = String(configured)
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  return parsed.length > 0 ? parsed : [...DEFAULT_RELAYS]
}

// Room ids are derived, never user supplied, so two clients on the same market
// always land on the same tag.
export function roomTag(pair, market) {
  const safePair = String(pair || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9/@._-]/g, '')
  const safeMarket = String(market || 'Perps').replace(/[^A-Za-z0-9_-]/g, '')
  return `${ROOM_NAMESPACE}:${safePair}:${safeMarket}`
}

// The room id the rest of the app already speaks: "BTC-USD_Perps".
export function roomId(pair, market) {
  return `${pair}_${market}`
}
