/**
 * @jest-environment node
 */

// The anti-spam layer. Each of these maps to a claim made about what it costs to
// get a message onto someone's screen.

const { generateSecretKey, getPublicKey } = require('nostr-tools/pure')
const {
  buildMessageEvent,
  countLeadingZeroBits,
  committedDifficulty,
  eventDifficulty,
  hasValidPow,
  isWellFormedMessage,
  toChatMessage,
} = require('../lib/nostr/event.js')
const { applyRateLimit, passesLocalChecks } = require('../lib/nostr/moderation.js')
const { roomTag, SPAM_POLICY } = require('../lib/nostr/config.js')

describe('proof of work', () => {
  it('counts leading zero bits the way NIP-13 defines them', () => {
    expect(countLeadingZeroBits('f'.repeat(64))).toBe(0)
    expect(countLeadingZeroBits(`7${'f'.repeat(63)}`)).toBe(1)
    expect(countLeadingZeroBits(`0${'f'.repeat(63)}`)).toBe(4)
    expect(countLeadingZeroBits(`00${'f'.repeat(62)}`)).toBe(8)
    expect(countLeadingZeroBits(`000f${'f'.repeat(60)}`)).toBe(12)
  })

  it('mines a message to the requested difficulty', async () => {
    const secretKey = generateSecretKey()
    const { event } = await buildMessageEvent({
      secretKey,
      pair: 'BTC-USD',
      market: 'Perps',
      content: 'gm',
      difficulty: 8,
    })

    expect(eventDifficulty(event)).toBeGreaterThanOrEqual(8)
    expect(committedDifficulty(event)).toBe(8)
    expect(hasValidPow(event, 8)).toBe(true)
  }, 30000)

  it('rejects a lucky hash that never committed to the work', async () => {
    const secretKey = generateSecretKey()
    const { event } = await buildMessageEvent({
      secretKey,
      pair: 'BTC-USD',
      market: 'Perps',
      content: 'gm',
      difficulty: 8,
    })

    // Same id, no nonce tag: claims work it never declared.
    const uncommitted = { ...event, tags: event.tags.filter((tag) => tag[0] !== 'nonce') }
    expect(hasValidPow(uncommitted, 8)).toBe(false)
  }, 30000)

  it('rejects a message claiming more work than its id shows', async () => {
    const secretKey = generateSecretKey()
    const { event } = await buildMessageEvent({
      secretKey,
      pair: 'BTC-USD',
      market: 'Perps',
      content: 'gm',
      difficulty: 4,
    })

    const overclaimed = {
      ...event,
      tags: event.tags.map((tag) => (tag[0] === 'nonce' ? ['nonce', tag[1], '32'] : tag)),
    }
    expect(hasValidPow(overclaimed, 32)).toBe(false)
  }, 30000)
})

describe('message shape', () => {
  const tag = roomTag('BTC-USD', 'Perps')

  it('accepts a well formed message for the room', async () => {
    const { event } = await buildMessageEvent({
      secretKey: generateSecretKey(),
      pair: 'BTC-USD',
      market: 'Perps',
      content: 'hello',
      difficulty: 0,
    })
    expect(isWellFormedMessage(event, tag)).toBe(true)
  })

  it('rejects a message tagged for a different room', async () => {
    const { event } = await buildMessageEvent({
      secretKey: generateSecretKey(),
      pair: 'ETH-USD',
      market: 'Perps',
      content: 'hello',
      difficulty: 0,
    })
    expect(isWellFormedMessage(event, tag)).toBe(false)
  })

  it('rejects timestamps from the future', async () => {
    const { event } = await buildMessageEvent({
      secretKey: generateSecretKey(),
      pair: 'BTC-USD',
      market: 'Perps',
      content: 'hello',
      difficulty: 0,
    })
    const future = { ...event, created_at: Math.floor(Date.now() / 1000) + 3600 }
    expect(isWellFormedMessage(future, tag)).toBe(false)
  })

  it('truncates rather than trusting a caller supplied length', async () => {
    const { event } = await buildMessageEvent({
      secretKey: generateSecretKey(),
      pair: 'BTC-USD',
      market: 'Perps',
      content: 'x'.repeat(5000),
      difficulty: 0,
    })
    expect(event.content.length).toBe(SPAM_POLICY.maxMessageLength)
  })

  it('never takes the address from the event itself', async () => {
    const { event } = await buildMessageEvent({
      secretKey: generateSecretKey(),
      pair: 'BTC-USD',
      market: 'Perps',
      content: 'hello',
      difficulty: 0,
    })
    // An event carrying a forged address tag must not influence the rendered one.
    const withForgedTag = { ...event, tags: [...event.tags, ['address', '0xdeadbeef']] }
    const message = toChatMessage(withForgedTag, '0xreal', 'BTC-USD', 'Perps')
    expect(message.address).toBe('0xreal')
  })
})

describe('local checks', () => {
  it('drops a message whose signature does not hold', async () => {
    const { event } = await buildMessageEvent({
      secretKey: generateSecretKey(),
      pair: 'BTC-USD',
      market: 'Perps',
      content: 'hello',
      difficulty: 0,
    })

    const tampered = { ...event, content: 'something else entirely' }
    const result = passesLocalChecks(tampered, { policy: { ...SPAM_POLICY, powDifficulty: 0 } })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('bad-signature')
  })

  it('drops a blocked author before doing any crypto', async () => {
    const secretKey = generateSecretKey()
    const { event } = await buildMessageEvent({
      secretKey,
      pair: 'BTC-USD',
      market: 'Perps',
      content: 'hello',
      difficulty: 0,
    })

    const blocked = new Set([getPublicKey(secretKey)])
    const result = passesLocalChecks(event, { policy: SPAM_POLICY, blocked })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('blocked')
  })
})

describe('rate limit', () => {
  const author = '0xabc'

  it('caps a flood at the configured rate', () => {
    const base = Date.now()
    const flood = Array.from({ length: 50 }, (_, index) => ({
      address: author,
      timestamp: base + index * 100,
      content: `spam ${index}`,
    }))

    expect(applyRateLimit(flood, 10)).toHaveLength(10)
  })

  it('lets the same author speak again in the next minute', () => {
    const base = Date.now()
    const messages = [
      ...Array.from({ length: 10 }, (_, index) => ({ address: author, timestamp: base + index * 100 })),
      { address: author, timestamp: base + 61000 },
    ]

    expect(applyRateLimit(messages, 10)).toHaveLength(11)
  })

  it('limits each author separately', () => {
    const base = Date.now()
    const messages = [
      ...Array.from({ length: 20 }, (_, index) => ({ address: '0xaaa', timestamp: base + index * 100 })),
      ...Array.from({ length: 20 }, (_, index) => ({ address: '0xbbb', timestamp: base + index * 100 })),
    ]

    const kept = applyRateLimit(messages, 10)
    expect(kept.filter((message) => message.address === '0xaaa')).toHaveLength(10)
    expect(kept.filter((message) => message.address === '0xbbb')).toHaveLength(10)
  })
})

describe('room tags', () => {
  it('is stable for the same market', () => {
    expect(roomTag('BTC-USD', 'Perps')).toBe(roomTag('BTC-USD', 'Perps'))
  })

  it('separates spot from perps', () => {
    expect(roomTag('BTC-USD', 'Spot')).not.toBe(roomTag('BTC-USD', 'Perps'))
  })

  it('strips anything that could smuggle a different room in', () => {
    expect(roomTag('BTC-USD"]}, {"kinds":[1]', 'Perps')).not.toContain('"')
    expect(roomTag('btc-usd', 'Perps')).toBe(roomTag('BTC-USD', 'Perps'))
  })
})
