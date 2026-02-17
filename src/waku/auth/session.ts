import { verifyMessage } from 'ethers';
import { SiweMessage } from 'siwe';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { etc, getPublicKey, sign, utils, verify } from '@noble/secp256k1';

export interface BuildSiweMessageParams {
  address: string;
  sessionPubKeyHex: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  chainId?: number;
  statement?: string;
  domain?: string;
  resources?: string[];
}

export interface SessionRecord {
  address: string;
  sessionPubKeyHex: string;
  allowedTopics?: string[];
  allowedPubsubTopics?: string[];
  issuedAt?: string;
  expiresAt: string;
}

export interface EnvelopeMetadata {
  contentTopic: string;
  pubsubTopic: string;
}

export interface SignedEnvelope<T> {
  message: T;
  senderAddress: string;
  sessionPubKey: string;
  timestampMs: number;
  messageId: string;
  signature: string;
}

const SESSION_URI_PREFIX = 'urn:session:';
const CONTENT_TOPIC_RESOURCE_PREFIX = 'urn:waku:contentTopic:';
const PUBSUB_TOPIC_RESOURCE_PREFIX = 'urn:waku:pubsubTopic:';

const { randomPrivateKey } = utils;
const { bytesToHex, hexToBytes, concatBytes } = etc;

const sharedEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;
const sharedDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : undefined;

function encodeUtf8(value: string) {
  if (sharedEncoder) return sharedEncoder.encode(value);
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'utf8');
  throw new Error('TextEncoder not available');
}

function decodeUtf8(bytes: Uint8Array) {
  if (sharedDecoder) return sharedDecoder.decode(bytes);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('utf8');
  throw new Error('TextDecoder not available');
}

function base64Encode(bytes: Uint8Array) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  if (typeof btoa !== 'undefined') {
    let binary = '';
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary);
  }
  throw new Error('Base64 encoding not supported in this runtime');
}

function base64Decode(payload: string) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(payload, 'base64'));
  }
  if (typeof atob !== 'undefined') {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  throw new Error('Base64 decoding not supported in this runtime');
}

if (!etc.hmacSha256Sync) {
  etc.hmacSha256Sync = (key: Uint8Array, ...messages: Uint8Array[]) =>
    hmac(sha256, key, concatBytes(...messages));
}

if (!etc.hmacSha256Async) {
  etc.hmacSha256Async = async (key: Uint8Array, ...messages: Uint8Array[]) =>
    etc.hmacSha256Sync!(key, ...messages);
}

function getRandomBytes(length: number) {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('Secure random generator unavailable');
  }
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return array;
}

export function generateSessionKeypair() {
  const privateKey = randomPrivateKey();
  const publicKey = getPublicKey(privateKey, true);
  return {
    privateKeyHex: bytesToHex(privateKey),
    publicKeyHex: bytesToHex(publicKey),
  };
}

export function buildSiweMessage(params: BuildSiweMessageParams) {
  const {
    address,
    sessionPubKeyHex,
    nonce,
    issuedAt,
    expirationTime,
    chainId = 1,
    statement = `${address} wants you to sign in with your Ethereum account`,
    domain = 'localhost',
    resources,
  } = params;

  const header = `${domain} wants you to sign in with your Ethereum account:`;
  const body: string[] = [header, address, ''];
  if (statement && statement !== header) {
    body.push(statement, '');
  }
  body.push(
    `URI: ${SESSION_URI_PREFIX}${sessionPubKeyHex}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  );
  if (resources && resources.length) {
    body.push('Resources:', ...resources.map((resource) => `- ${resource}`));
  }
  return body.join('\n');
}

export function parseSiweMessage(siweMessage: string) {
  return new SiweMessage(siweMessage);
}

function extractSessionPubKeyFromUri(uri?: string) {
  if (!uri || !uri.startsWith(SESSION_URI_PREFIX)) return undefined;
  const key = uri.slice(SESSION_URI_PREFIX.length);
  const normalized = key.startsWith('0x') ? key.slice(2) : key;
  if (!normalized || !/^[a-fA-F0-9]+$/.test(normalized)) return undefined;
  return normalized;
}

export function extractSessionPubKey(siweMessage: string | SiweMessage) {
  const siwe = typeof siweMessage === 'string' ? parseSiweMessage(siweMessage) : siweMessage;
  const fromUri = extractSessionPubKeyFromUri(siwe.uri);
  if (fromUri) return fromUri;
  const resources = siwe.resources ?? [];
  for (const resource of resources) {
    const fromResource = extractSessionPubKeyFromUri(resource);
    if (fromResource) return fromResource;
  }
  throw new Error('Session public key missing from SIWE message');
}

export function extractTopicBindings(siweMessage: string | SiweMessage) {
  const siwe = typeof siweMessage === 'string' ? parseSiweMessage(siweMessage) : siweMessage;
  const resources = siwe.resources ?? [];
  const contentTopics: string[] = [];
  const pubsubTopics: string[] = [];
  for (const resource of resources) {
    if (resource.startsWith(CONTENT_TOPIC_RESOURCE_PREFIX)) {
      contentTopics.push(resource.slice(CONTENT_TOPIC_RESOURCE_PREFIX.length));
      continue;
    }
    if (resource.startsWith(PUBSUB_TOPIC_RESOURCE_PREFIX)) {
      pubsubTopics.push(resource.slice(PUBSUB_TOPIC_RESOURCE_PREFIX.length));
      continue;
    }
    if (resource.startsWith('/')) {
      contentTopics.push(resource);
    }
  }
  return { contentTopics, pubsubTopics };
}

export function verifySiweAuthorization(params: {
  siweMessage: string;
  siweSignature: string;
  expectedAddress?: string;
}) {
  const { siweMessage, siweSignature, expectedAddress } = params;
  const siwe = parseSiweMessage(siweMessage);
  const recovered = verifyMessage(siweMessage, siweSignature);
  if (expectedAddress && recovered.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error('Recovered address does not match expected delegator');
  }
  if (siwe.address && recovered.toLowerCase() !== siwe.address.toLowerCase()) {
    throw new Error('Recovered address does not match SIWE address');
  }
  const sessionPubKeyHex = extractSessionPubKey(siwe);
  return { address: recovered, sessionPubKeyHex, siwe };
}

export function canonicalizeEnvelope<T>(input: {
  metadata: EnvelopeMetadata;
  message: T;
  sessionPubKey: string;
  timestampMs: number;
}) {
  return JSON.stringify({
    contentTopic: input.metadata.contentTopic,
    pubsubTopic: input.metadata.pubsubTopic,
    message: input.message,
    timestampMs: input.timestampMs,
    sessionPubKey: input.sessionPubKey,
  });
}

export function hashEnvelopeContent<T>(input: {
  metadata: EnvelopeMetadata;
  message: T;
  sessionPubKey: string;
  timestampMs: number;
}) {
  const canonical = canonicalizeEnvelope(input);
  return sha256(new TextEncoder().encode(canonical));
}

export function signEnvelope<T>(params: {
  metadata: EnvelopeMetadata;
  message: T;
  senderAddress: string;
  sessionPrivKeyHex: string;
  sessionPubKeyHex?: string;
  timestampMs?: number;
}): SignedEnvelope<T> {
  const { metadata, message, senderAddress, sessionPrivKeyHex, sessionPubKeyHex, timestampMs } = params;
  const privKeyBytes = hexToBytes(sessionPrivKeyHex);
  const sessionPubKey = sessionPubKeyHex || bytesToHex(getPublicKey(privKeyBytes, true));
  const ts = timestampMs ?? Date.now();
  const hash = hashEnvelopeContent({ metadata, message, sessionPubKey, timestampMs: ts });
  const signature = sign(hash, privKeyBytes);
  const signatureHex =
    typeof signature === 'string'
      ? signature
      : signature instanceof Uint8Array
      ? bytesToHex(signature)
      : signature.toCompactHex();
  const messageId = bytesToHex(hash);

  return {
    message,
    senderAddress,
    sessionPubKey,
    timestampMs: ts,
    messageId,
    signature: signatureHex,
  };
}

export function verifyEnvelope<T>(params: {
  metadata: EnvelopeMetadata;
  envelope: SignedEnvelope<T>;
}) {
  const { metadata, envelope } = params;
  const hash = hashEnvelopeContent({
    metadata,
    message: envelope.message,
    sessionPubKey: envelope.sessionPubKey,
    timestampMs: envelope.timestampMs,
  });
  if (bytesToHex(hash) !== envelope.messageId) {
    return false;
  }
  return verify(envelope.signature, hash, envelope.sessionPubKey);
}

export function encodeEnvelopePayload<T>(envelope: SignedEnvelope<T>) {
  const json = JSON.stringify(envelope);
  return base64Encode(encodeUtf8(json));
}

export function decodeEnvelopePayload<T>(payloadBase64: string) {
  const json = decodeUtf8(base64Decode(payloadBase64));
  return JSON.parse(json) as SignedEnvelope<T>;
}

export function createNonce(bytes = 8) {
  return bytesToHex(getRandomBytes(bytes));
}

export function deriveSessionId(params: { siweMessage: string; siweSignature: string }) {
  const data = encodeUtf8(`${params.siweMessage}::${params.siweSignature}`);
  return bytesToHex(sha256(data));
}
