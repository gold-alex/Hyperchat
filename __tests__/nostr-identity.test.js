/**
 * @jest-environment node
 */

// Identity is the load-bearing piece: if a binding can be forged, the wallet gate
// and everything built on it is decoration. These use real EIP-712 signatures from
// a real key, not fixtures.

const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts')
const {
  bindingTypedData,
  buildBindingEvent,
  deriveSecretKey,
  identityFromLoginSignature,
  loginTypedData,
  verifyBindingEvent,
} = require('../lib/nostr/identity.js')

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

async function makeIdentity(account) {
  const login = await signTyped(account, loginTypedData(account.address))
  const identity = await identityFromLoginSignature(account.address, login)
  const typedData = bindingTypedData(account.address, identity.pubkey, Date.now())
  const signature = await signTyped(account, typedData)
  return { identity, event: buildBindingEvent(identity, signature, typedData), typedData }
}

describe('chat identity derivation', () => {
  it('derives the same chat key every time from the same login signature', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const signature = await signTyped(account, loginTypedData(account.address))

    const first = await identityFromLoginSignature(account.address, signature)
    const second = await identityFromLoginSignature(account.address, signature)

    expect(first.pubkey).toBe(second.pubkey)
    expect(first.secretKeyHex).toBe(second.secretKeyHex)
    expect(first.pubkey).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives different wallets different identities', async () => {
    const a = privateKeyToAccount(generatePrivateKey())
    const b = privateKeyToAccount(generatePrivateKey())

    const aIdentity = await identityFromLoginSignature(a.address, await signTyped(a, loginTypedData(a.address)))
    const bIdentity = await identityFromLoginSignature(b.address, await signTyped(b, loginTypedData(b.address)))

    expect(aIdentity.pubkey).not.toBe(bIdentity.pubkey)
  })

  it('refuses to derive from a non-signature', async () => {
    await expect(deriveSecretKey('not a signature')).rejects.toThrow(/not hex/)
    await expect(deriveSecretKey('')).rejects.toThrow()
  })

  it('does not leak the login signature into the published binding', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const login = await signTyped(account, loginTypedData(account.address))
    const { event } = await makeIdentity(account)

    // The login signature IS the key material. If it ever appears on the wire,
    // anyone who reads the event owns the identity.
    expect(event.content).not.toContain(login)
  })
})

describe('binding verification', () => {
  it('accepts a genuine binding and recovers the address', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const { identity, event } = await makeIdentity(account)

    const verified = await verifyBindingEvent(event)

    expect(verified).not.toBeNull()
    expect(verified.address).toBe(account.address.toLowerCase())
    expect(verified.pubkey).toBe(identity.pubkey)
  })

  it('rejects a binding claiming an address that did not sign it', async () => {
    const victim = privateKeyToAccount(generatePrivateKey())
    const attacker = privateKeyToAccount(generatePrivateKey())
    const { event } = await makeIdentity(attacker)

    // Swap in the victim's address, everywhere it appears.
    const claim = JSON.parse(event.content)
    claim.address = victim.address.toLowerCase()
    claim.typedData.message.address = victim.address.toLowerCase()
    const forged = { ...event, content: JSON.stringify(claim) }

    expect(await verifyBindingEvent(forged)).toBeNull()
  })

  it('rejects a binding lifted onto someone else"s chat key', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const other = privateKeyToAccount(generatePrivateKey())
    const { event } = await makeIdentity(account)
    const { identity: otherIdentity } = await makeIdentity(other)

    // Replay a valid wallet signature under a different chat key.
    const stolen = { ...event, pubkey: otherIdentity.pubkey }

    expect(await verifyBindingEvent(stolen)).toBeNull()
  })

  it('rejects tampered message content', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const { event } = await makeIdentity(account)

    const claim = JSON.parse(event.content)
    claim.typedData.message.statement = 'Give this person admin'
    const tampered = { ...event, content: JSON.stringify(claim) }

    expect(await verifyBindingEvent(tampered)).toBeNull()
  })

  it('rejects junk without throwing', async () => {
    expect(await verifyBindingEvent(null)).toBeNull()
    expect(await verifyBindingEvent({})).toBeNull()
    expect(await verifyBindingEvent({ kind: 10411, content: 'not json', tags: [], pubkey: 'x' })).toBeNull()
    expect(await verifyBindingEvent({ kind: 1, content: '{}' })).toBeNull()
  })
})
