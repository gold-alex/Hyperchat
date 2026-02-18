import { etc, verify } from './noble-secp256k1.js';

const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_MESSAGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_BALANCE_CACHE_MS = 2 * 60 * 1000;
const SIGNATURE_FAILURE_REASON = 'invalid_envelope_signature';

const sharedEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;

export class EnvelopeReceiverFilter {
  constructor(config = {}) {
    this.config = {
      maxClockSkewMs: config.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
      messageTtlMs: config.messageTtlMs ?? DEFAULT_MESSAGE_TTL_MS,
      allowlist: (config.allowlist ?? []).map((addr) => addr.toLowerCase()),
      denylist: (config.denylist ?? []).map((addr) => addr.toLowerCase()),
      balanceCacheTtlMs: config.balanceCacheTtlMs ?? DEFAULT_BALANCE_CACHE_MS,
      minBalanceWei: config.minBalanceWei,
      balanceProvider: config.balanceProvider,
      allowLegacyUnsignedSenderAddress: config.allowLegacyUnsignedSenderAddress === true,
    };
    this.seenIds = new Map();
    this.balanceCache = new Map();
  }

  clearCaches() {
    this.seenIds.clear();
    this.balanceCache.clear();
  }

  async evaluateEnvelope(payloadBase64, metadata) {
    let envelope;
    try {
      envelope = decodeEnvelopePayload(payloadBase64);
    } catch (err) {
      return { accepted: false, reason: err.message };
    }
    return this._evaluate(envelope, metadata);
  }

  async evaluateMessage(message) {
    const normalizedMessage = normalizeSignedMessage(message);
    const fallbackMessageId = await deriveMessageId(message);
    const fakeEnvelope = {
      message: normalizedMessage,
      senderAddress: message.address,
      sessionPubKey: message.sessionPubKey || '',
      timestampMs: Number(message.timestamp ?? Date.now()),
      messageId: message.messageId || fallbackMessageId,
      signature: message.signature || '',
    };
    return this._evaluate(fakeEnvelope, { contentTopic: message.contentTopic || '', pubsubTopic: message.pubsubTopic || '' });
  }

  async _evaluate(envelope, metadata) {
    if (shouldVerifyEnvelopeSignature(envelope, metadata)) {
      const signatureValid = await verifyEnvelopeSignature(
        envelope,
        metadata,
        this.config.allowLegacyUnsignedSenderAddress,
      );
      if (!signatureValid) {
        return { accepted: false, reason: SIGNATURE_FAILURE_REASON };
      }
    }
    if (!this._withinSkew(envelope.timestampMs)) {
      return { accepted: false, reason: 'timestamp_out_of_window' };
    }
    if (!this._trackId(envelope.messageId)) {
      return { accepted: false, reason: 'duplicate' };
    }
    const sender = envelope.senderAddress?.toLowerCase?.() || '';
    if (this.config.denylist.includes(sender)) {
      return { accepted: false, reason: 'denied_sender' };
    }
    if (this.config.allowlist.includes(sender)) {
      return { accepted: true, envelope };
    }
    if (this.config.minBalanceWei && !(await this._hasBalance(sender))) {
      return { accepted: false, reason: 'insufficient_balance' };
    }
    return { accepted: true, envelope };
  }

  _withinSkew(timestampMs) {
    return Math.abs(Date.now() - Number(timestampMs)) <= this.config.maxClockSkewMs;
  }

  _trackId(id) {
    const now = Date.now();
    const prev = this.seenIds.get(id);
    if (prev && now - prev < this.config.messageTtlMs) return false;
    this.seenIds.set(id, now);
    if (this.seenIds.size > 1000) {
      for (const [key, ts] of this.seenIds.entries()) {
        if (now - ts >= this.config.messageTtlMs) this.seenIds.delete(key);
      }
    }
    return true;
  }

  async _hasBalance(address) {
    if (!this.config.minBalanceWei) return true;
    const provider = this.config.balanceProvider;
    if (!provider) throw new Error('balanceProvider required when minBalanceWei set');
    const normalized = address.toLowerCase();
    const cached = this.balanceCache.get(normalized);
    const now = Date.now();
    if (cached && now - cached.timestamp < this.config.balanceCacheTtlMs) {
      return cached.value >= BigInt(this.config.minBalanceWei);
    }
    const value = await provider(normalized);
    this.balanceCache.set(normalized, { value, timestamp: now });
    return value >= BigInt(this.config.minBalanceWei);
  }
}

function decodeEnvelopePayload(payloadBase64) {
  const json = typeof Buffer !== 'undefined'
    ? Buffer.from(payloadBase64, 'base64').toString('utf8')
    : atob(payloadBase64);
  return JSON.parse(json);
}

function normalizeSignedMessage(message) {
  if (!message || typeof message !== 'object') {
    return message;
  }
  if (message.envelopeMessage && typeof message.envelopeMessage === 'object') {
    return message.envelopeMessage;
  }
  return {
    content: message.content ?? message.text ?? '',
    name: message.name ?? '',
  };
}

function shouldVerifyEnvelopeSignature(envelope, metadata) {
  return Boolean(
    metadata?.contentTopic &&
      metadata?.pubsubTopic &&
      envelope?.sessionPubKey &&
      envelope?.signature &&
      envelope?.messageId,
  );
}

async function verifyEnvelopeSignature(envelope, metadata, allowLegacyUnsignedSenderAddress = false) {
  try {
    const hash = await hashEnvelopeContent({
      metadata,
      message: envelope.message,
      senderAddress: envelope.senderAddress,
      sessionPubKey: envelope.sessionPubKey,
      timestampMs: Number(envelope.timestampMs),
    });
    const normalizedMessageId = normalizeHex(envelope.messageId);
    if (
      normalizeHex(etc.bytesToHex(hash)) === normalizedMessageId &&
      verify(String(envelope.signature), hash, String(envelope.sessionPubKey))
    ) {
      return true;
    }
    if (!allowLegacyUnsignedSenderAddress) {
      return false;
    }
    const legacyHash = await hashLegacyEnvelopeContent({
      metadata,
      message: envelope.message,
      sessionPubKey: envelope.sessionPubKey,
      timestampMs: Number(envelope.timestampMs),
    });
    if (normalizeHex(etc.bytesToHex(legacyHash)) !== normalizedMessageId) {
      return false;
    }
    return verify(String(envelope.signature), legacyHash, String(envelope.sessionPubKey));
  } catch {
    return false;
  }
}

function canonicalizeEnvelope(input) {
  return JSON.stringify({
    contentTopic: input.metadata.contentTopic,
    pubsubTopic: input.metadata.pubsubTopic,
    message: input.message,
    senderAddress: normalizeAddress(input.senderAddress),
    timestampMs: input.timestampMs,
    sessionPubKey: input.sessionPubKey,
  });
}

function canonicalizeLegacyEnvelope(input) {
  return JSON.stringify({
    contentTopic: input.metadata.contentTopic,
    pubsubTopic: input.metadata.pubsubTopic,
    message: input.message,
    timestampMs: input.timestampMs,
    sessionPubKey: input.sessionPubKey,
  });
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer);
  if (typeof input === 'string') {
    if (!sharedEncoder) throw new Error('TextEncoder not available');
    return sharedEncoder.encode(input);
  }
  return new Uint8Array(input || []);
}

async function hashEnvelopeContent(input) {
  const canonical = canonicalizeEnvelope(input);
  const bytes = toBytes(canonical);
  return sha256Bytes(bytes);
}

async function hashLegacyEnvelopeContent(input) {
  const canonical = canonicalizeLegacyEnvelope(input);
  const bytes = toBytes(canonical);
  return sha256Bytes(bytes);
}

async function sha256Bytes(bytes) {
  if (globalThis.crypto?.subtle?.digest) {
    const buffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(buffer);
  }
  try {
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(Buffer.from(bytes)).digest();
    return new Uint8Array(hash);
  } catch {
    throw new Error('SHA-256 unavailable');
  }
}

function normalizeHex(value) {
  return String(value || '').replace(/^0x/i, '').toLowerCase();
}

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

async function deriveMessageId(message) {
  const raw = `${message.address || ''}-${message.timestamp || ''}-${message.content || ''}-${message.signature || ''}`;
  try {
    const hash = await sha256Bytes(toBytes(raw));
    return normalizeHex(etc.bytesToHex(hash));
  } catch (_) {
    return raw;
  }
}
