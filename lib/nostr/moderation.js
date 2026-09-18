// What earns a message a place on screen.
//
// Every check here runs in every client, at render time. That is the whole design:
// there is no server to compromise, and someone who reimplements our format can
// publish whatever they like to a public relay without reaching a single screen.
//
// Ordered cheapest first, so the expensive network checks only ever run on
// messages that already look real.
//
//   1. proof of work   - a local hash, free
//   2. block list      - a set lookup, free
//   3. signature       - local crypto
//   4. wallet binding  - one relay round trip, cached forever
//   5. traded on HL    - one API call, cached; the one that costs a spammer money
//   6. rate limit      - applied over the merged room, at paint time

import { KIND_BINDING, KIND_BLOCKLIST, SPAM_POLICY } from './config.js'
import { hasValidPow, verifyMessageSignature } from './event.js'
import { verifyBindingEvent, normalizeAddress } from './identity.js'
import { defaultStore } from './store.js'

const HL_API = 'https://api.hyperliquid.xyz/info'

// --- 1-3: local checks ----------------------------------------------------

export function passesLocalChecks(event, { policy = SPAM_POLICY, blocked = new Set() } = {}) {
  if (blocked.has(event.pubkey)) return { ok: false, reason: 'blocked' }
  if (!hasValidPow(event, policy.powDifficulty)) return { ok: false, reason: 'insufficient-pow' }
  if (!verifyMessageSignature(event)) return { ok: false, reason: 'bad-signature' }
  return { ok: true }
}

// --- 4: wallet bindings ---------------------------------------------------

// Ask the relays who these authors claim to be, verify each claim, remember the
// answer. Unknown authors resolve to null and stay invisible.
export async function fetchBindings(pool, pubkeys, { timeoutMs = 6000, store = defaultStore } = {}) {
  const resolved = new Map()
  const unknown = []

  for (const pubkey of new Set(pubkeys)) {
    const cached = await store.getBinding(pubkey)
    if (cached) resolved.set(pubkey, cached.address)
    else unknown.push(pubkey)
  }

  if (unknown.length === 0) return resolved

  const subId = `bindings:${Math.random().toString(36).slice(2, 10)}`
  const candidates = new Map()

  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pool.unsubscribe(subId)
      resolve()
    }

    const timer = setTimeout(finish, timeoutMs)

    pool.subscribe(
      subId,
      [{ kinds: [KIND_BINDING], authors: unknown }],
      {
        onEvent: (event) => {
          // Relays are replaceable-event stores, but nothing stops one serving a
          // stale binding. Keep the newest per author and verify that one.
          const existing = candidates.get(event.pubkey)
          if (!existing || event.created_at > existing.created_at) {
            candidates.set(event.pubkey, event)
          }
        },
        onEose: (_url, done, total) => {
          if (total > 0 && done >= total) finish()
        },
      },
    )
  })

  for (const pubkey of unknown) {
    const event = candidates.get(pubkey)
    const verified = event ? await verifyBindingEvent(event) : null
    const address = verified?.address || null

    resolved.set(pubkey, address)
    // Cache negatives too - an unbound key should not cost a round trip per paint.
    await store.putBinding(pubkey, address)
  }

  return resolved
}

// --- 5: has this address actually traded on Hyperliquid? ------------------
//
// The gate that matters. Keypairs are free and Ethereum addresses are free, so
// anything that only asks "do you have a wallet" is theatre. Funded, traded
// Hyperliquid accounts cost real money, one deposit at a time.

const activityCache = new Map()
const ACTIVITY_TTL_MS = 30 * 60 * 1000

async function hlPost(body) {
  const response = await fetch(HL_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Hyperliquid API ${response.status}`)
  return response.json()
}

export async function checkTradingActivity(address, { policy = SPAM_POLICY } = {}) {
  const key = normalizeAddress(address)
  if (!key) return { ok: false, reason: 'no-address' }
  if (policy.requires === 'none') return { ok: true }

  const cached = activityCache.get(key)
  if (cached && Date.now() - cached.checkedAt < ACTIVITY_TTL_MS) return cached.result

  let result
  try {
    const [state, fills] = await Promise.all([
      hlPost({ type: 'clearinghouseState', user: key }).catch(() => null),
      hlPost({ type: 'userFills', user: key }).catch(() => null),
    ])

    const accountValue = Number(state?.marginSummary?.accountValue ?? 0)
    const hasFills = Array.isArray(fills) && fills.length > 0

    if (policy.requires === 'equity') {
      result =
        accountValue >= policy.minAccountValueUsd
          ? { ok: true }
          : { ok: false, reason: 'below-equity-threshold' }
    } else {
      // 'traded': any fill history, or funds sitting on the exchange.
      result = hasFills || accountValue > 0 ? { ok: true } : { ok: false, reason: 'never-traded' }
    }
  } catch {
    // Hyperliquid being unreachable must not blank the room. Fail open on the
    // activity check only - binding and signature checks still stand.
    result = { ok: true, degraded: true }
  }

  activityCache.set(key, { checkedAt: Date.now(), result })
  return result
}

export function clearActivityCache() {
  activityCache.clear()
}

// --- 6: rate limit --------------------------------------------------------

// Applied when drawing, over the merged room, not when sending. That is what makes
// it hold against a reimplemented client: their code does not get a vote on what
// your panel paints.
export function applyRateLimit(messages, maxPerMinute = SPAM_POLICY.maxMessagesPerMinute) {
  if (!maxPerMinute) return messages

  const windows = new Map()
  const kept = []

  for (const message of messages) {
    const author = message.address || message.pubkey
    let window = windows.get(author)
    if (!window) {
      window = []
      windows.set(author, window)
    }

    const cutoff = message.timestamp - 60000
    while (window.length > 0 && window[0] < cutoff) window.shift()

    if (window.length < maxPerMinute) {
      window.push(message.timestamp)
      kept.push(message)
    }
  }

  return kept
}

// --- block lists ----------------------------------------------------------

// A moderator signs a list; every client honours it by default. One ban reaches
// everyone in seconds with no server and no deploy.
export async function fetchBlocklist(pool, moderatorPubkeys, { timeoutMs = 5000 } = {}) {
  const blocked = new Set()
  if (!moderatorPubkeys || moderatorPubkeys.length === 0) return blocked

  const subId = `blocklist:${Math.random().toString(36).slice(2, 10)}`

  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pool.unsubscribe(subId)
      resolve()
    }

    const timer = setTimeout(finish, timeoutMs)

    pool.subscribe(
      subId,
      [{ kinds: [KIND_BLOCKLIST], authors: moderatorPubkeys }],
      {
        onEvent: (event) => {
          if (!verifyMessageSignature(event)) return
          for (const tag of event.tags || []) {
            if (tag[0] === 'p' && tag[1]) blocked.add(tag[1])
          }
        },
        onEose: (_url, done, total) => {
          if (total > 0 && done >= total) finish()
        },
      },
    )
  })

  return blocked
}
