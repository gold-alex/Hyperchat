import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
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
