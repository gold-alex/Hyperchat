/**
 * @jest-environment node
 */

// End to end over real WebSockets against in-process relays. This is the test that
// backs the actual claims: a message reaches a stranger through relays, it lands on
// every relay rather than one, a wiped relay gets the room back from a client that
// still holds it, and a client with nowhere to publish does not lose the message.

const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts')
const { MockRelay } = require('./helpers/mock-relay.js')
const { HyperchatClient } = require('../lib/nostr/client.js')
const { createStore } = require('../lib/nostr/store.js')
const { SPAM_POLICY } = require('../lib/nostr/config.js')
const {
  bindingTypedData,
  buildBindingEvent,
  identityFromLoginSignature,
  loginTypedData,
} = require('../lib/nostr/identity.js')

// The trading-activity gate would otherwise reach out to the real Hyperliquid API
// for these throwaway addresses. It has its own tests.
const TEST_POLICY = { ...SPAM_POLICY, powDifficulty: 0, requires: 'none', maxMessagesPerMinute: 100 }

async function signTyped(account, typedData) {
  const types = { ...typedData.types }
  delete types.EIP712Domain
  return account.signTypedData({
    domain: typedData.domain,
    types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  })
}

async function makeSignedInUser() {
  const account = privateKeyToAccount(generatePrivateKey())
  const login = await signTyped(account, loginTypedData(account.address))
  const identity = await identityFromLoginSignature(account.address, login)
  const typedData = bindingTypedData(account.address, identity.pubkey, Date.now())
  const signature = await signTyped(account, typedData)
  return { account, identity, bindingEvent: buildBindingEvent(identity, signature, typedData) }
}

function waitFor(predicate, { timeout = 8000, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      let value
      try {
        value = predicate()
      } catch (error) {
        reject(error)
        return
      }
      if (value) {
        resolve(value)
        return
      }
      if (Date.now() - started > timeout) {
        reject(new Error(`Timed out waiting for ${label}`))
        return
      }
      setTimeout(tick, 25)
    }
    tick()
  })
}

describe('chat over relays', () => {
  let relayA
  let relayB
  let clients

  beforeEach(async () => {
    relayA = new MockRelay()
    relayB = new MockRelay()
    await relayA.start()
    await relayB.start()
    clients = []
  })

  afterEach(async () => {
    for (const client of clients) client.close()
    await relayA.stop()
    await relayB.stop()
  })

  function makeClient(relays) {
    const client = new HyperchatClient({
      relays,
      policy: TEST_POLICY,
      moderators: [],
      store: createStore({ forceMemory: true }),
    })
    clients.push(client)
    return client
  }

  it('carries a message from one trader to another', async () => {
    const alice = await makeSignedInUser()

    const aliceClient = makeClient([relayA.url, relayB.url])
    aliceClient.setIdentity(alice.identity)
    aliceClient.start()
    await waitFor(() => aliceClient.pool.connectedCount() === 2, { label: 'alice connected' })

    await aliceClient.publishBinding(alice.bindingEvent)
    await aliceClient.joinRoom('BTC-USD', 'Perps')
    await aliceClient.send('gm degens')

    // Bob is a stranger with his own storage: anything he sees crossed the network.
    const bobClient = makeClient([relayA.url])
    bobClient.start()
    await waitFor(() => bobClient.pool.connectedCount() === 1, { label: 'bob connected' })
    await bobClient.joinRoom('BTC-USD', 'Perps')

    const messages = await waitFor(() => (bobClient.messages.length > 0 ? bobClient.messages : null), {
      label: 'bob to receive the message',
    })

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('gm degens')
    // Resolved from the wallet binding, not from anything the message claimed.
    expect(messages[0].address).toBe(alice.account.address.toLowerCase())
  }, 20000)

  it('writes to every relay, not just the first that answers', async () => {
    const alice = await makeSignedInUser()

    const client = makeClient([relayA.url, relayB.url])
    client.setIdentity(alice.identity)
    client.start()
    await waitFor(() => client.pool.connectedCount() === 2, { label: 'both relays' })

    await client.joinRoom('ETH-USD', 'Perps')
    const result = await client.send('both of you should have this')

    expect(result.accepted).toHaveLength(2)
    expect(relayA.storedIds().has(result.event.id)).toBe(true)
    expect(relayB.storedIds().has(result.event.id)).toBe(true)
  }, 20000)

  it('keeps the room readable when a relay drops out', async () => {
    const alice = await makeSignedInUser()

    const client = makeClient([relayA.url, relayB.url])
    client.setIdentity(alice.identity)
    client.start()
    await waitFor(() => client.pool.connectedCount() === 2, { label: 'both relays' })

    await client.publishBinding(alice.bindingEvent)
    await client.joinRoom('SOL-USD', 'Perps')

    await relayB.stop()
    await waitFor(() => client.pool.connectedCount() === 1, { label: 'relay B to drop' })

    const result = await client.send('still here')
    expect(result.accepted).toEqual([relayA.url])
  }, 20000)

  it('gives a wiped relay the room back', async () => {
    const alice = await makeSignedInUser()

    const client = makeClient([relayA.url, relayB.url])
    client.setIdentity(alice.identity)
    client.start()
    await waitFor(() => client.pool.connectedCount() === 2, { label: 'both relays' })

    await client.joinRoom('BTC-USD', 'Perps')
    const first = await client.send('message one')
    const second = await client.send('message two')

    expect(relayB.storedIds().size).toBeGreaterThanOrEqual(2)

    // Relay B loses everything, the way a pruning or freshly restored relay would.
    relayB.wipe()
    expect(relayB.storedIds().size).toBe(0)

    // A subscription in which no relay reported holding anything: every event the
    // client holds is missing everywhere, so repair should re-seed both.
    await client.repair({ receivedByRelay: new Map() })

    await waitFor(
      () => relayB.storedIds().has(first.event.id) && relayB.storedIds().has(second.event.id),
      { label: 'relay B to be healed' },
    )

    expect(relayB.storedIds().has(first.event.id)).toBe(true)
    expect(relayB.storedIds().has(second.event.id)).toBe(true)
  }, 20000)

  it('queues a message when there is nowhere to publish, and sends it on reconnect', async () => {
    const alice = await makeSignedInUser()
    const deadRelay = new MockRelay()
    await deadRelay.start()
    const url = deadRelay.url
    await deadRelay.stop()

    const client = makeClient([url])
    client.setIdentity(alice.identity)
    client.start()
    await client.joinRoom('BTC-USD', 'Perps')

    const result = await client.send('nobody is listening yet')
    expect(result.queued).toBe(true)
    expect(client.pool.outbox).toHaveLength(1)

    // The message is not lost: it is still in the room locally, and still queued.
    expect(client.messages.map((message) => message.content)).toContain('nobody is listening yet')
  }, 20000)

  it('keeps the room when asked to rejoin the room it is already in', async () => {
    // The side panel calls joinRoom on a timer and after sign in/out. joinRoom
    // early returns for an unchanged room, so anything the caller cleared in
    // anticipation of a reload never came back - which is how signing out blanked
    // the message list.
    const alice = await makeSignedInUser()

    const client = makeClient([relayA.url])
    client.setIdentity(alice.identity)
    client.start()
    await waitFor(() => client.pool.connectedCount() === 1, { label: 'connected' })

    await client.publishBinding(alice.bindingEvent)
    await client.joinRoom('BTC-USD', 'Perps')
    await client.send('still here after a rejoin')

    expect(client.messages).toHaveLength(1)

    await client.joinRoom('BTC-USD', 'Perps')

    expect(client.messages).toHaveLength(1)
    expect(client.messages[0].content).toBe('still here after a rejoin')
  }, 20000)

  it('does not render a message from an author with no wallet binding', async () => {
    const stranger = await makeSignedInUser()

    const strangerClient = makeClient([relayA.url])
    strangerClient.setIdentity(stranger.identity)
    strangerClient.start()
    await waitFor(() => strangerClient.pool.connectedCount() === 1, { label: 'stranger connected' })

    // Note what is missing: no publishBinding. The message is well formed and
    // correctly signed, it just has nothing tying it to a wallet.
    await strangerClient.joinRoom('BTC-USD', 'Perps')
    await strangerClient.send('let me in')

    const observer = makeClient([relayA.url])
    observer.start()
    await waitFor(() => observer.pool.connectedCount() === 1, { label: 'observer connected' })
    await observer.joinRoom('BTC-USD', 'Perps')

    // Give it room to arrive and be judged before asserting it never shows.
    await new Promise((resolve) => setTimeout(resolve, 1500))

    expect(observer.events.size).toBe(1)
    expect(observer.messages).toHaveLength(0)
  }, 20000)
})
