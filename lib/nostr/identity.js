// Wallet-bound chat identity.
//
// A nostr event is signed by a nostr key, not by an Ethereum key, so on its own
// it says nothing about who is behind it. We close that gap with two EIP-712
// signatures taken once, at sign-in:
//
//   1. Login    - deterministic, never published. Hashed into the chat key, so the
//                 same wallet reproduces the same identity on any device.
//   2. Binding  - published. Proves to everyone else that this chat key belongs to
//                 that Ethereum address.
//
// After that the wallet is never touched again: messages are signed by the derived
// key, so sending is instant instead of one wallet popup per message.
//
// Why two signatures and not one: the login signature IS the private key material.
// Publishing it would hand the identity to anyone who read the event, so the proof
// that goes on the wire has to be a separate signature.

import { getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { recoverTypedDataAddress } from 'viem'
import { KIND_BINDING } from './config.js'

const EIP712_DOMAIN = { name: 'HyperChat', version: '2' }

const DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
]

// No timestamp, no nonce: this struct must hash identically forever, or the same
// wallet would derive a different chat key on every sign-in.
const LOGIN_TYPE = {
  HyperChatLogin: [
    { name: 'statement', type: 'string' },
    { name: 'address', type: 'address' },
  ],
}

const BINDING_TYPE = {
  HyperChatIdentity: [
    { name: 'statement', type: 'string' },
    { name: 'address', type: 'address' },
    { name: 'chatPubkey', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
  ],
}

const LOGIN_STATEMENT =
  'Derive my HyperChat identity. This is a signature, not a transaction: it moves no funds and grants no approvals.'

const BINDING_STATEMENT =
  'Link this HyperChat identity to my wallet so other traders can verify who I am.'

const KEY_DERIVATION_DOMAIN = 'hyperchat-chat-key-v1'

// Web Crypto rather than a hashing library: Chrome and Node both ship it, so the
// identity path carries no dependency of its own.
async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return new Uint8Array(digest)
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex) {
  const pairs = String(hex).match(/.{1,2}/g) || []
  return Uint8Array.from(pairs.map((pair) => parseInt(pair, 16)))
}

export function normalizeAddress(address) {
  return String(address || '').toLowerCase()
}

export function loginTypedData(address) {
  return {
    domain: EIP712_DOMAIN,
    primaryType: 'HyperChatLogin',
    types: { EIP712Domain: DOMAIN_TYPE, ...LOGIN_TYPE },
    message: {
      statement: LOGIN_STATEMENT,
      address: normalizeAddress(address),
    },
  }
}

export function bindingTypedData(address, chatPubkey, timestamp) {
  return {
    domain: EIP712_DOMAIN,
    primaryType: 'HyperChatIdentity',
    types: { EIP712Domain: DOMAIN_TYPE, ...BINDING_TYPE },
    message: {
      statement: BINDING_STATEMENT,
      address: normalizeAddress(address),
      chatPubkey: String(chatPubkey),
      timestamp: Number(timestamp),
    },
  }
}

// viem derives EIP712Domain from `domain`, and rejects it being declared twice.
function typesForViem(types) {
  const copy = { ...types }
  delete copy.EIP712Domain
  return copy
}

// secp256k1 scalars must land in [1, n). A sha256 digest misses that range with
// probability around 2^-128, but rehash rather than hand nostr-tools a bad key.
export async function deriveSecretKey(loginSignature) {
  const signature = String(loginSignature || '').toLowerCase()
  if (!/^0x[0-9a-f]+$/.test(signature)) {
    throw new Error('Cannot derive chat identity: login signature is not hex')
  }

  let material = new TextEncoder().encode(`${KEY_DERIVATION_DOMAIN}|${signature}`)
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = await sha256(material)
    try {
      getPublicKey(candidate)
      return candidate
    } catch {
      material = candidate
    }
  }
  throw new Error('Cannot derive chat identity: no valid key found')
}

// Step 1 of sign-in. Deterministic: same wallet, same identity, any device.
export async function identityFromLoginSignature(address, loginSignature) {
  const secretKey = await deriveSecretKey(loginSignature)
  return {
    address: normalizeAddress(address),
    secretKey,
    secretKeyHex: bytesToHex(secretKey),
    pubkey: getPublicKey(secretKey),
  }
}

// Step 2 of sign-in. The published half: a nostr event, signed by the chat key,
// carrying the wallet's signature over that same chat key. Anyone can check both
// halves and conclude the address authorised this identity.
export function buildBindingEvent(identity, bindingSignature, typedData) {
  const content = JSON.stringify({
    address: normalizeAddress(identity.address),
    signature: bindingSignature,
    typedData,
  })

  return finalizeEvent(
    {
      kind: KIND_BINDING,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['i', `ethereum:${normalizeAddress(identity.address)}`],
        ['client', 'hyperchat'],
      ],
      content,
    },
    identity.secretKey,
  )
}

// The check every client runs before it will render a word from someone. Returns
// the proven address, or null. Never throws on hostile input - a malformed binding
// is just an unverified stranger.
export async function verifyBindingEvent(event) {
  try {
    if (!event || event.kind !== KIND_BINDING) return null
    if (!verifyEvent(event)) return null

    const claim = JSON.parse(event.content)
    const { address, signature, typedData } = claim || {}
    if (!address || !signature || !typedData || !typedData.message) return null

    // The wallet must have signed over THIS chat key, not some other one.
    if (String(typedData.message.chatPubkey) !== event.pubkey) return null
    if (normalizeAddress(typedData.message.address) !== normalizeAddress(address)) return null

    // Pin the struct shape so a crafted payload cannot get a different digest
    // recovered into a valid-looking address.
    if (typedData.primaryType !== 'HyperChatIdentity') return null
    if (typedData.domain?.name !== EIP712_DOMAIN.name) return null
    if (typedData.domain?.version !== EIP712_DOMAIN.version) return null
    if (typedData.message.statement !== BINDING_STATEMENT) return null

    const recovered = await recoverTypedDataAddress({
      domain: typedData.domain,
      types: typesForViem(typedData.types),
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    })

    if (normalizeAddress(recovered) !== normalizeAddress(address)) return null

    return {
      pubkey: event.pubkey,
      address: normalizeAddress(address),
      boundAt: event.created_at,
    }
  } catch {
    return null
  }
}

// --- local persistence ----------------------------------------------------
// The derived key lives in extension storage so sign-in survives a browser
// restart. Worst case for a stolen profile is chat impersonation: this key cannot
// move funds and is not the user's Ethereum key.

const STORAGE_KEY = 'hyperchatIdentity'

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && chrome?.storage?.local
}

export async function saveIdentity(identity, bindingEvent) {
  if (!hasChromeStorage()) return
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      address: identity.address,
      secretKeyHex: identity.secretKeyHex,
      pubkey: identity.pubkey,
      bindingEvent: bindingEvent || null,
    },
  })
}

export async function loadIdentity() {
  if (!hasChromeStorage()) return null
  const stored = await chrome.storage.local.get([STORAGE_KEY])
  const record = stored?.[STORAGE_KEY]
  if (!record?.secretKeyHex || !record?.address) return null

  // Rebuild from the stored hex rather than trusting the cached pubkey.
  const secretKey = hexToBytes(record.secretKeyHex)

  return {
    identity: {
      address: normalizeAddress(record.address),
      secretKey,
      secretKeyHex: record.secretKeyHex,
      pubkey: getPublicKey(secretKey),
    },
    bindingEvent: record.bindingEvent || null,
  }
}

export async function clearIdentity() {
  if (!hasChromeStorage()) return
  await chrome.storage.local.remove([STORAGE_KEY])
}
