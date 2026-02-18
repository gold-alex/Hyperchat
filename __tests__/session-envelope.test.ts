import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { sha256 } from '@noble/hashes/sha256';
import { etc, sign } from '@noble/secp256k1';
import {
  buildSiweMessage,
  createNonce,
  decodeEnvelopePayload,
  encodeEnvelopePayload,
  EnvelopeMetadata,
  extractTopicBindings,
  generateSessionKeypair,
  signEnvelope,
  verifyEnvelope,
  verifySiweAuthorization,
  extractSessionPubKey,
} from '../src/waku/auth/session';

describe('Session + envelope helpers', () => {
  const { bytesToHex, hexToBytes } = etc;

  function signLegacyEnvelope<T>(params: {
    metadata: EnvelopeMetadata;
    message: T;
    senderAddress: string;
    sessionPrivKeyHex: string;
    sessionPubKeyHex: string;
    timestampMs: number;
  }) {
    const canonical = JSON.stringify({
      contentTopic: params.metadata.contentTopic,
      pubsubTopic: params.metadata.pubsubTopic,
      message: params.message,
      timestampMs: params.timestampMs,
      sessionPubKey: params.sessionPubKeyHex,
    });
    const hash = sha256(new TextEncoder().encode(canonical));
    const signature = sign(hash, hexToBytes(params.sessionPrivKeyHex));
    const signatureHex =
      typeof signature === 'string'
        ? signature
        : signature instanceof Uint8Array
        ? bytesToHex(signature)
        : signature.toCompactHex();
    return {
      message: params.message,
      senderAddress: params.senderAddress,
      sessionPubKey: params.sessionPubKeyHex,
      timestampMs: params.timestampMs,
      messageId: bytesToHex(hash),
      signature: signatureHex,
    };
  }

  it('creates SIWE message that embeds session pubkey and verifies signature', async () => {
    const { publicKeyHex } = generateSessionKeypair();
    const wallet = Wallet.createRandom();

    const nonce = createNonce();
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const msg = buildSiweMessage({
      address: wallet.address,
      sessionPubKeyHex: publicKeyHex,
      nonce,
      issuedAt,
      expirationTime,
    });

    expect(msg).toContain(publicKeyHex);
    expect(extractSessionPubKey(msg)).toEqual(publicKeyHex);

    const signature = await wallet.signMessage(msg);
    const result = verifySiweAuthorization({ siweMessage: msg, siweSignature: signature });
    expect(result.address.toLowerCase()).toEqual(wallet.address.toLowerCase());
    expect(result.sessionPubKeyHex).toEqual(publicKeyHex);
  });

  it('signs and verifies envelopes deterministically', () => {
    const { privateKeyHex, publicKeyHex } = generateSessionKeypair();
    const metadata: EnvelopeMetadata = {
      contentTopic: '/waku-auth-lite/1/chat/json',
      pubsubTopic: '/waku/2/rs/999/0',
    };
    const senderWallet = Wallet.createRandom();
    const message = { text: 'Hello', timestamp: 1736533685 };

    const envelope = signEnvelope({
      metadata,
      message,
      senderAddress: senderWallet.address,
      sessionPrivKeyHex: privateKeyHex,
      sessionPubKeyHex: publicKeyHex,
      timestampMs: 1736533685000,
    });

    expect(envelope.sessionPubKey).toEqual(publicKeyHex);
    expect(envelope.messageId).toHaveLength(64);
    expect(verifyEnvelope({ metadata, envelope })).toBe(true);

    const tampered = { ...envelope, message: { ...message, text: 'tampered' } };
    expect(verifyEnvelope({ metadata, envelope: tampered })).toBe(false);

    const tamperedSender = { ...envelope, senderAddress: Wallet.createRandom().address };
    expect(verifyEnvelope({ metadata, envelope: tamperedSender })).toBe(false);
  });

  it('normalizes sender address casing for deterministic messageId/signature', () => {
    const { privateKeyHex, publicKeyHex } = generateSessionKeypair();
    const metadata: EnvelopeMetadata = {
      contentTopic: '/waku-auth-lite/1/chat/json',
      pubsubTopic: '/waku/2/rs/999/0',
    };
    const wallet = Wallet.createRandom();
    const message = { text: 'Hello', timestamp: 1736533685 };
    const timestampMs = 1736533685000;

    const lower = signEnvelope({
      metadata,
      message,
      senderAddress: wallet.address.toLowerCase(),
      sessionPrivKeyHex: privateKeyHex,
      sessionPubKeyHex: publicKeyHex,
      timestampMs,
    });
    const checksum = signEnvelope({
      metadata,
      message,
      senderAddress: wallet.address,
      sessionPrivKeyHex: privateKeyHex,
      sessionPubKeyHex: publicKeyHex,
      timestampMs,
    });

    expect(lower.messageId).toBe(checksum.messageId);
    expect(lower.signature).toBe(checksum.signature);
    expect(verifyEnvelope({ metadata, envelope: lower })).toBe(true);
    expect(verifyEnvelope({ metadata, envelope: checksum })).toBe(true);
  });

  it('rejects legacy unsigned-sender envelopes by default and allows via explicit compatibility mode', () => {
    const { privateKeyHex, publicKeyHex } = generateSessionKeypair();
    const metadata: EnvelopeMetadata = {
      contentTopic: '/waku-auth-lite/1/chat/json',
      pubsubTopic: '/waku/2/rs/999/0',
    };
    const senderWallet = Wallet.createRandom();
    const legacyEnvelope = signLegacyEnvelope({
      metadata,
      message: { text: 'legacy', timestamp: 1736533685 },
      senderAddress: senderWallet.address,
      sessionPrivKeyHex: privateKeyHex,
      sessionPubKeyHex: publicKeyHex,
      timestampMs: 1736533685000,
    });

    expect(verifyEnvelope({ metadata, envelope: legacyEnvelope })).toBe(false);
    expect(
      verifyEnvelope({
        metadata,
        envelope: legacyEnvelope,
        allowLegacyUnsignedSenderAddress: true,
      }),
    ).toBe(true);
  });

  it('encodes and decodes envelope payloads symmetrically', () => {
    const { privateKeyHex } = generateSessionKeypair();
    const metadata: EnvelopeMetadata = {
      contentTopic: '/waku-auth-lite/1/chat/json',
      pubsubTopic: '/waku/2/rs/999/0',
    };
    const message = { text: 'Hello', timestamp: Date.now() };
    const senderWallet = Wallet.createRandom();

    const envelope = signEnvelope({
      metadata,
      message,
      senderAddress: senderWallet.address,
      sessionPrivKeyHex: privateKeyHex,
    });

    const payload = encodeEnvelopePayload(envelope);
    const decoded = decodeEnvelopePayload<typeof message>(payload);
    expect(decoded).toEqual(envelope);
    expect(verifyEnvelope({ metadata, envelope: decoded })).toBe(true);
  });

  it('extracts session pubkey from resources when URI does not include it', () => {
    const { publicKeyHex } = generateSessionKeypair();
    const wallet = Wallet.createRandom();
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const msg = buildSiweMessage({
      address: wallet.address,
      sessionPubKeyHex: publicKeyHex,
      nonce: createNonce(),
      issuedAt,
      expirationTime,
      resources: [`urn:session:${publicKeyHex}`],
    });

    const overridden = msg.replace(
      `URI: urn:session:${publicKeyHex}`,
      'URI: https://example.com',
    );

    expect(extractSessionPubKey(overridden)).toEqual(publicKeyHex);
  });

  it('throws when session pubkey is missing from SIWE message', () => {
    const { publicKeyHex } = generateSessionKeypair();
    const wallet = Wallet.createRandom();
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const msg = buildSiweMessage({
      address: wallet.address,
      sessionPubKeyHex: publicKeyHex,
      nonce: createNonce(),
      issuedAt,
      expirationTime,
    });

    const overridden = msg.replace(
      `URI: urn:session:${publicKeyHex}`,
      'URI: https://example.com',
    );

    expect(() => extractSessionPubKey(overridden)).toThrow('Session public key missing');
  });

  it('parses content and pubsub topic bindings from SIWE resources', () => {
    const { publicKeyHex } = generateSessionKeypair();
    const wallet = Wallet.createRandom();
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const contentTopic = '/waku-auth-lite/1/test/json';
    const pubsubTopic = '/waku/2/rs/999/0';
    const msg = buildSiweMessage({
      address: wallet.address,
      sessionPubKeyHex: publicKeyHex,
      nonce: createNonce(),
      issuedAt,
      expirationTime,
      resources: [
        `urn:waku:contentTopic:${contentTopic}`,
        `urn:waku:pubsubTopic:${pubsubTopic}`,
      ],
    });

    const bindings = extractTopicBindings(msg);
    expect(bindings.contentTopics).toContain(contentTopic);
    expect(bindings.pubsubTopics).toContain(pubsubTopic);

    const legacyTopic = '/legacy/1/chat/json';
    const legacyBindings = extractTopicBindings({ resources: [legacyTopic] } as any);
    expect(legacyBindings.contentTopics).toContain(legacyTopic);
  });
});
