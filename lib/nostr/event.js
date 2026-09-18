// Chat message events: build, mine, sign, parse.

import { getEventHash, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { KIND_MESSAGE, SPAM_POLICY, roomTag } from './config.js'

// NIP-13: difficulty is the count of leading zero BITS on the event id. Each extra
// bit doubles the work, so 20 bits is ~1M hashes - imperceptible once, painful a
// thousand times over.
export function countLeadingZeroBits(idHex) {
  let bits = 0
  for (const char of idHex) {
    const nibble = parseInt(char, 16)
    if (Number.isNaN(nibble)) return bits
    if (nibble === 0) {
      bits += 4
      continue
    }
    // Math.clz32 of a 4-bit value overshoots by 28.
    bits += Math.clz32(nibble) - 28
    break
  }
  return bits
}

export function eventDifficulty(event) {
  return countLeadingZeroBits(event.id)
}

// The difficulty the author *committed* to. Without this, someone could get a
// lucky hash at difficulty 0 and claim it as deliberate work.
export function committedDifficulty(event) {
  const nonceTag = (event.tags || []).find((tag) => tag[0] === 'nonce')
  if (!nonceTag || nonceTag.length < 3) return 0
  const target = parseInt(nonceTag[2], 10)
  return Number.isFinite(target) ? target : 0
}

export function hasValidPow(event, required) {
  if (!required) return true
  if (committedDifficulty(event) < required) return false
  return eventDifficulty(event) >= required
}

// Yield without setTimeout. Nested setTimeout(0) is clamped to 4ms once it nests
// a few deep, so yielding every 1024 hashes at difficulty 20 spent ~4 seconds
// sitting in the timer queue - several times longer than the hashing itself.
// A MessageChannel round trip is a real macrotask with no clamp.
function createYielder() {
  if (typeof MessageChannel === 'undefined') {
    return { yield: () => new Promise((resolve) => setTimeout(resolve, 0)), done: () => {} }
  }

  const channel = new MessageChannel()
  channel.port1.unref?.()
  channel.port2.unref?.()

  return {
    yield: () =>
      new Promise((resolve) => {
        channel.port1.onmessage = () => resolve()
        channel.port2.postMessage(0)
      }),
    done: () => {
      channel.port1.close()
      channel.port2.close()
    },
  }
}

// How many hashes between yields. Large enough that yield overhead disappears,
// small enough that the panel still repaints while mining.
const HASHES_PER_YIELD = 8192

// Grind the nonce tag until the id has enough leading zeros.
export async function mineEvent(draft, difficulty, timeoutMs = SPAM_POLICY.powTimeoutMs) {
  if (!difficulty) return draft

  const started = Date.now()
  const tags = (draft.tags || []).filter((tag) => tag[0] !== 'nonce')
  const yielder = createYielder()
  let nonce = 0

  try {
    for (;;) {
      const candidate = {
        ...draft,
        tags: [...tags, ['nonce', String(nonce), String(difficulty)]],
      }
      candidate.id = getEventHash(candidate)

      if (countLeadingZeroBits(candidate.id) >= difficulty) return candidate

      nonce++

      if (nonce % HASHES_PER_YIELD === 0) {
        if (Date.now() - started > timeoutMs) {
          // Better a message that sends than a panel that hangs. Peers enforcing
          // PoW will drop it; the sender is told in the UI.
          return { ...draft, tags }
        }
        await yielder.yield()
      }
    }
  } finally {
    yielder.done()
  }
}

export async function buildMessageEvent({
  secretKey,
  pair,
  market,
  content,
  name,
  difficulty = SPAM_POLICY.powDifficulty,
}) {
  const trimmed = String(content || '').slice(0, SPAM_POLICY.maxMessageLength)
  if (!trimmed.trim()) throw new Error('Cannot send an empty message')

  const tags = [
    ['d', roomTag(pair, market)],
    ['client', 'hyperchat'],
  ]
  if (name) tags.push(['n', String(name)])

  const draft = {
    kind: KIND_MESSAGE,
    pubkey: getPublicKey(secretKey),
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: trimmed,
  }

  const mined = await mineEvent(draft, difficulty)
  const signed = finalizeEvent(
    {
      kind: mined.kind,
      created_at: mined.created_at,
      tags: mined.tags,
      content: mined.content,
    },
    secretKey,
  )

  return {
    event: signed,
    minedDifficulty: eventDifficulty(signed),
    requestedDifficulty: difficulty,
  }
}

export function tagValue(event, key) {
  const tag = (event.tags || []).find((entry) => entry[0] === key)
  return tag ? tag[1] : null
}

export function eventRoomTag(event) {
  return tagValue(event, 'd')
}

// Shape checks only - no signature work, so this is cheap enough to run over a
// whole relay dump before deciding what deserves real verification.
export function isWellFormedMessage(event, expectedRoomTag) {
  if (!event || event.kind !== KIND_MESSAGE) return false
  if (typeof event.content !== 'string' || !event.content.trim()) return false
  if (event.content.length > SPAM_POLICY.maxMessageLength) return false
  if (typeof event.created_at !== 'number') return false
  if (expectedRoomTag && eventRoomTag(event) !== expectedRoomTag) return false

  const nowSec = Math.floor(Date.now() / 1000)
  if (event.created_at > nowSec + SPAM_POLICY.maxClockSkewSec) return false

  return true
}

export function verifyMessageSignature(event) {
  try {
    // Verify a canonical copy rather than the object we were handed. nostr-tools
    // marks verified events with a symbol and short-circuits on it, and that mark
    // survives an object spread - so an event derived from a verified one can
    // arrive pre-approved with different content. Rebuilding from the seven signed
    // fields drops the mark along with anything else riding on the object.
    const canonical = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    }

    // The id must be the hash of the content, or the signature is over something
    // other than what we are about to render.
    if (getEventHash(canonical) !== canonical.id) return false

    return verifyEvent(canonical)
  } catch {
    return false
  }
}

// Nostr event -> the message shape the existing UI already renders. `address` is
// resolved from the author's wallet binding, never taken from the event itself.
export function toChatMessage(event, address, pair, market) {
  return {
    id: event.id,
    pubkey: event.pubkey,
    address: address || null,
    name: tagValue(event, 'n') || '',
    content: event.content,
    timestamp: event.created_at * 1000,
    pair,
    market,
    room: `${pair}_${market}`,
  }
}
