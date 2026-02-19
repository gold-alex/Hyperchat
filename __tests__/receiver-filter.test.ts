import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha256';
import { etc, sign } from '@noble/secp256k1';
import {
  createNonce,
  encodeEnvelopePayload,
  EnvelopeMetadata,
  generateSessionKeypair,
  signEnvelope,
} from '../src/waku/auth/session';
import { EnvelopeReceiverFilter } from '../lib/waku-receiver-filter.js';
import { Wallet } from 'ethers';

describe('EnvelopeReceiverFilter', () => {
  const metadata: EnvelopeMetadata = {
    contentTopic: '/waku-auth-lite/1/chat/json',
    pubsubTopic: '/waku/2/rs/999/0',
  };
  const { bytesToHex, hexToBytes } = etc;

  function buildEnvelope(overrides: Partial<Record<'timestampMs' | 'messageId', number>> = {}) {
    const session = generateSessionKeypair();
    const wallet = Wallet.createRandom();
    const timestampMs = overrides.timestampMs ?? Date.now();
    const envelope = signEnvelope({
      metadata,
      message: { text: 'hello', timestamp: timestampMs },
      senderAddress: wallet.address,
      sessionPrivKeyHex: session.privateKeyHex,
      sessionPubKeyHex: session.publicKeyHex,
      timestampMs,
    });
    if (overrides.messageId) {
      envelope.messageId = overrides.messageId.toString(16);
    }
    return { envelope, session, wallet };
  }

  function mutateHex(hex: string) {
    if (!hex || hex.length === 0) return hex;
    const index = hex.startsWith('0x') ? 2 : 0;
    const target = hex[index] || '0';
    const replacement = target.toLowerCase() === 'f' ? '0' : 'f';
    return `${hex.slice(0, index)}${replacement}${hex.slice(index + 1)}`;
  }

  function buildLegacyEnvelope() {
    const session = generateSessionKeypair();
    const wallet = Wallet.createRandom();
    const timestampMs = Date.now();
    const message = { text: 'hello', timestamp: timestampMs };
    const canonical = JSON.stringify({
      contentTopic: metadata.contentTopic,
      pubsubTopic: metadata.pubsubTopic,
      message,
      timestampMs,
      sessionPubKey: session.publicKeyHex,
    });
    const hash = sha256(new TextEncoder().encode(canonical));
    const signature = sign(hash, hexToBytes(session.privateKeyHex));
    const signatureHex =
      typeof signature === 'string'
        ? signature
        : signature instanceof Uint8Array
        ? bytesToHex(signature)
        : signature.toCompactHex();

    return {
      message,
      senderAddress: wallet.address,
      sessionPubKey: session.publicKeyHex,
      timestampMs,
      messageId: bytesToHex(hash),
      signature: signatureHex,
    };
  }

  it('accepts valid envelopes', async () => {
    const filter = new EnvelopeReceiverFilter();
    const { envelope } = buildEnvelope();
    const payload = encodeEnvelopePayload(envelope);
    const result = await filter.evaluateEnvelope(payload, metadata);
    expect(result.accepted).toBe(true);
    expect(result.accepted && 'envelope' in result ? result.envelope?.message.text : undefined).toBe('hello');
  });

  it('rejects duplicates and remembers TTL', async () => {
    const filter = new EnvelopeReceiverFilter({ messageTtlMs: 10_000 });
    const { envelope } = buildEnvelope({ timestampMs: Date.now() });
    const payload = encodeEnvelopePayload(envelope);
    expect((await filter.evaluateEnvelope(payload, metadata)).accepted).toBe(true);
    expect((await filter.evaluateEnvelope(payload, metadata)).accepted).toBe(false);
  });

  it('rejects envelopes with invalid signatures', async () => {
    const filter = new EnvelopeReceiverFilter();
    const { envelope } = buildEnvelope();
    envelope.signature = mutateHex(envelope.signature);
    const payload = encodeEnvelopePayload(envelope);
    const result = await filter.evaluateEnvelope(payload, metadata);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_envelope_signature');
  });

  it('rejects sender-tampered envelopes when signature was created for a different sender', async () => {
    const filter = new EnvelopeReceiverFilter();
    const { envelope } = buildEnvelope();
    envelope.senderAddress = Wallet.createRandom().address;
    const payload = encodeEnvelopePayload(envelope);
    const result = await filter.evaluateEnvelope(payload, metadata);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_envelope_signature');
  });

  it('rejects timestamps outside skew window', async () => {
    const filter = new EnvelopeReceiverFilter({ maxClockSkewMs: 1_000 });
    const { envelope } = buildEnvelope({ timestampMs: Date.now() - 10_000 });
    const payload = encodeEnvelopePayload(envelope);
    const result = await filter.evaluateEnvelope(payload, metadata);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('timestamp_out_of_window');
  });

  it('rejects insufficient balances and respects allowlist', async () => {
    const provider = vi.fn().mockResolvedValue(BigInt(0));
    const filter = new EnvelopeReceiverFilter({
      minBalanceWei: BigInt(1),
      balanceProvider: provider,
      allowlist: ['0xabc'],
    });
    const { envelope, wallet } = buildEnvelope();
    envelope.senderAddress = wallet.address;
    const payload = encodeEnvelopePayload(envelope);
    const result = await filter.evaluateEnvelope(payload, metadata);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('insufficient_balance');
    expect(provider).toHaveBeenCalledTimes(1);

    const allowFilter = new EnvelopeReceiverFilter({
      minBalanceWei: BigInt(1),
      balanceProvider: provider,
      allowlist: [wallet.address],
    });
    const accepted = await allowFilter.evaluateEnvelope(payload, metadata);
    expect(accepted.accepted).toBe(true);
  });

  it('short-circuits balance checks on signature failure', async () => {
    const provider = vi.fn().mockResolvedValue(BigInt(0));
    const filter = new EnvelopeReceiverFilter({
      minBalanceWei: BigInt(1),
      balanceProvider: provider,
    });
    const { envelope } = buildEnvelope();
    envelope.signature = mutateHex(envelope.signature);
    const payload = encodeEnvelopePayload(envelope);
    const result = await filter.evaluateEnvelope(payload, metadata);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_envelope_signature');
    expect(provider).not.toHaveBeenCalled();
  });

  it('caches balance lookups within TTL', async () => {
    const provider = vi.fn().mockResolvedValue(BigInt(10));
    const filter = new EnvelopeReceiverFilter({
      minBalanceWei: BigInt(1),
      balanceProvider: provider,
      balanceCacheTtlMs: 60_000,
    });
    const { envelope } = buildEnvelope();
    const payload = encodeEnvelopePayload(envelope);
    await filter.evaluateEnvelope(payload, metadata);
    await filter.evaluateEnvelope(payload, metadata);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('supports direct message evaluation', async () => {
    const filter = new EnvelopeReceiverFilter({ messageTtlMs: 1000 });
    const { envelope } = buildEnvelope();
    const message = {
      address: envelope.senderAddress,
      timestamp: envelope.timestampMs,
      content: envelope.message.text,
      signature: envelope.signature,
    };
    const result = await filter.evaluateMessage(message);
    expect(result.accepted).toBe(true);
  });

  it('derives SHA-256 fallback message id when messageId is missing', async () => {
    const filter = new EnvelopeReceiverFilter({ messageTtlMs: 1000 });
    const timestamp = Date.now();
    const message = {
      address: '0x1234',
      timestamp,
      content: 'fallback-id-test',
      signature: '0xabcdef',
    };
    const raw = `${message.address}-${message.timestamp}-${message.content}-${message.signature}`;
    const expectedMessageId = createHash('sha256').update(raw, 'utf8').digest('hex');

    const result = await filter.evaluateMessage(message);
    expect(result.accepted).toBe(true);

    const [trackedId] = Array.from(filter.seenIds.keys());
    expect(trackedId).toMatch(/^[a-f0-9]{64}$/);
    expect(trackedId).toBe(expectedMessageId);
  });

  it('deduplicates direct messages with missing messageId using fallback derivation', async () => {
    const filter = new EnvelopeReceiverFilter({ messageTtlMs: 10_000 });
    const timestamp = Date.now();
    const message = {
      address: '0xabcd',
      timestamp,
      content: 'dedupe-fallback-test',
      signature: '0x012345',
    };

    const first = await filter.evaluateMessage(message);
    const second = await filter.evaluateMessage(message);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('duplicate');
  });

  it('rejects invalid signature in evaluateMessage when auth-lite envelope fields are provided', async () => {
    const filter = new EnvelopeReceiverFilter();
    const { envelope } = buildEnvelope();
    const message = {
      address: envelope.senderAddress,
      timestamp: envelope.timestampMs,
      content: envelope.message.text,
      signature: mutateHex(envelope.signature),
      sessionPubKey: envelope.sessionPubKey,
      messageId: envelope.messageId,
      contentTopic: metadata.contentTopic,
      pubsubTopic: metadata.pubsubTopic,
      envelopeMessage: envelope.message,
    };
    const result = await filter.evaluateMessage(message);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_envelope_signature');
  });

  it('rejects legacy unsigned-sender envelopes', async () => {
    const legacyEnvelope = buildLegacyEnvelope();
    const payload = encodeEnvelopePayload(legacyEnvelope);

    const strictFilter = new EnvelopeReceiverFilter();
    const strictResult = await strictFilter.evaluateEnvelope(payload, metadata);
    expect(strictResult.accepted).toBe(false);
    expect(strictResult.reason).toBe('invalid_envelope_signature');

  });
});
