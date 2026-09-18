#!/usr/bin/env node

// strfry write policy: the same rules the extension enforces at render time,
// applied at your relay's front door so junk never reaches its disk.
//
// strfry speaks to this over stdin/stdout, one JSON object per line, and expects
// one decision per line back.
//
// Deliberately not done here: verifying the wallet binding. That needs EIP-712
// recovery, which means pulling a crypto stack into the relay's hot path for a
// check every client already performs and cannot be talked out of. A binding this
// relay accepts still renders nowhere unless it actually verifies.

const readline = require('node:readline')

const KIND_MESSAGE = 9411
const KIND_BINDING = 10411
const KIND_BLOCKLIST = 10412

const ALLOWED_KINDS = new Set([KIND_MESSAGE, KIND_BINDING, KIND_BLOCKLIST])

const POW_DIFFICULTY = Number(process.env.HYPERCHAT_POW_DIFFICULTY ?? 20)
const MAX_CONTENT_LENGTH = Number(process.env.HYPERCHAT_MAX_CONTENT ?? 500)
const MAX_PER_MINUTE = Number(process.env.HYPERCHAT_MAX_PER_MINUTE ?? 10)
const MAX_FUTURE_SEC = 300
const ROOM_PREFIX = 'hyperchat:'

function countLeadingZeroBits(idHex) {
  let bits = 0
  for (const char of idHex) {
    const nibble = parseInt(char, 16)
    if (Number.isNaN(nibble)) return bits
    if (nibble === 0) {
      bits += 4
      continue
    }
    bits += Math.clz32(nibble) - 28
    break
  }
  return bits
}

function committedDifficulty(event) {
  const nonce = (event.tags || []).find((tag) => tag[0] === 'nonce')
  if (!nonce || nonce.length < 3) return 0
  const target = parseInt(nonce[2], 10)
  return Number.isFinite(target) ? target : 0
}

// pubkey -> timestamps, trimmed to the last minute on each check.
const recent = new Map()

function withinRateLimit(pubkey, nowSec) {
  const cutoff = nowSec - 60
  const seen = (recent.get(pubkey) || []).filter((timestamp) => timestamp > cutoff)

  if (seen.length >= MAX_PER_MINUTE) {
    recent.set(pubkey, seen)
    return false
  }

  seen.push(nowSec)
  recent.set(pubkey, seen)
  return true
}

// Keep the rate-limit map from growing without bound on a busy relay.
setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - 60
  for (const [pubkey, timestamps] of recent) {
    const live = timestamps.filter((timestamp) => timestamp > cutoff)
    if (live.length === 0) recent.delete(pubkey)
    else recent.set(pubkey, live)
  }
}, 60000).unref()

function decide(event) {
  if (!ALLOWED_KINDS.has(event.kind)) {
    return { accept: false, msg: 'blocked: not a HyperChat event' }
  }

  const nowSec = Math.floor(Date.now() / 1000)
  if (event.created_at > nowSec + MAX_FUTURE_SEC) {
    return { accept: false, msg: 'invalid: timestamp is in the future' }
  }

  if (event.kind === KIND_MESSAGE) {
    const room = (event.tags || []).find((tag) => tag[0] === 'd')?.[1]
    if (!room || !room.startsWith(ROOM_PREFIX)) {
      return { accept: false, msg: 'blocked: message is not tagged to a HyperChat room' }
    }

    if ((event.content || '').length > MAX_CONTENT_LENGTH) {
      return { accept: false, msg: 'invalid: message too long' }
    }

    if (POW_DIFFICULTY > 0) {
      if (committedDifficulty(event) < POW_DIFFICULTY) {
        return { accept: false, msg: `pow: ${POW_DIFFICULTY} bits required` }
      }
      if (countLeadingZeroBits(event.id) < POW_DIFFICULTY) {
        return { accept: false, msg: `pow: ${POW_DIFFICULTY} bits required` }
      }
    }

    if (!withinRateLimit(event.pubkey, nowSec)) {
      return { accept: false, msg: 'rate-limited: slow down' }
    }
  }

  return { accept: true }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  if (!line.trim()) return

  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }

  let verdict
  try {
    verdict = decide(request.event || {})
  } catch (error) {
    // Never take the relay down over one malformed event.
    verdict = { accept: false, msg: 'error: policy failed to evaluate' }
  }

  process.stdout.write(`${JSON.stringify({ id: request.event?.id, action: verdict.accept ? 'accept' : 'reject', msg: verdict.msg || '' })}\n`)
})
