import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';
import supertest from 'supertest';
import { createServer as createHttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { sha256 } from '@noble/hashes/sha256';
import { etc, sign } from '@noble/secp256k1';

import {
  buildSiweMessage,
  createNonce,
  encodeEnvelopePayload,
  generateSessionKeypair,
  signEnvelope,
} from '../src/waku/auth/session';
import { __gatewayTestUtils, createGatewayServer } from '../src/waku/gateway/server';
import type { GatewayConfig } from '../src/waku/gateway/server';

const metadata = {
  contentTopic: '/waku-auth-lite/1/chat/json',
  pubsubTopic: '/waku/2/rs/999/0',
};
const gatewayDomain = 'gateway.local';
const boundResources = [
  `urn:waku:contentTopic:${metadata.contentTopic}`,
  `urn:waku:pubsubTopic:${metadata.pubsubTopic}`,
];
const sessionTtlMs = 60 * 60 * 1000;
const getDecodedPayloadBytes = (payloadBase64: string) => Buffer.from(payloadBase64, 'base64').length;
const parseJsonLogEvents = (calls: unknown[][]) =>
  calls
    .map((call) => call[0])
    .map((entry) => {
      try {
        return JSON.parse(String(entry));
      } catch {
        return null;
      }
    })
    .filter((event): event is Record<string, unknown> => Boolean(event));
const { bytesToHex, hexToBytes } = etc;

const signLegacyEnvelope = (params: {
  message: Record<string, unknown>;
  senderAddress: string;
  sessionPrivKeyHex: string;
  sessionPubKeyHex: string;
  timestampMs: number;
}) => {
  const canonical = JSON.stringify({
    contentTopic: metadata.contentTopic,
    pubsubTopic: metadata.pubsubTopic,
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
};

const buildBoundSiwe = (params: { address: string; sessionPubKeyHex: string }) => {
  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(Date.parse(issuedAt) + sessionTtlMs).toISOString();
  return buildSiweMessage({
    address: params.address,
    sessionPubKeyHex: params.sessionPubKeyHex,
    nonce: createNonce(),
    issuedAt,
    expirationTime,
    domain: gatewayDomain,
    resources: boundResources,
  });
};

describe('gateway server', () => {
  let rpcServer: ReturnType<typeof createHttpServer>;
  let rpcUrl: string;
  let lastRpcBody: any;
  let rpcCallCount = 0;

  beforeAll(async () => {
    rpcServer = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        lastRpcBody = raw ? JSON.parse(raw) : undefined;
        rpcCallCount += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', result: 'ok', id: lastRpcBody?.id ?? 1 }));
      });
    });
    await new Promise<void>((resolve) => rpcServer.listen(0, resolve));
    const port = (rpcServer.address() as AddressInfo).port;
    rpcUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
  });

  beforeEach(() => {
    lastRpcBody = undefined;
    rpcCallCount = 0;
  });

  it('accepts session and relays message payloads unchanged', async () => {
    const app = createGatewayServer({
      rpcUrl,
      allowedTopics: [metadata.contentTopic],
      allowedPubsubTopics: [metadata.pubsubTopic],
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
    });
    const agent = supertest(app);
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const siweMessage = buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });
    const siweSignature = await wallet.signMessage(siweMessage);
    const sessionRes = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);
    const { sessionId } = sessionRes.body;
    expect(sessionId).toBeTruthy();

    const message = { text: 'Hello Gateway', timestamp: Date.now() };
    const envelope = signEnvelope({
      metadata,
      message,
      senderAddress: wallet.address,
      sessionPrivKeyHex: session.privateKeyHex,
      sessionPubKeyHex: session.publicKeyHex,
    });
    const payloadBase64 = encodeEnvelopePayload(envelope);

    await agent
      .post('/message')
      .send({ sessionId, contentTopic: metadata.contentTopic, pubsubTopic: metadata.pubsubTopic, payloadBase64 })
      .expect(200);

    expect(lastRpcBody).toBeDefined();
    expect(lastRpcBody.method).toBe('post_waku_v2_relay_v1_message');
    expect(lastRpcBody.params[1].payload).toBe(payloadBase64);
    expect(lastRpcBody.params[1].contentTopic).toBe(metadata.contentTopic);
    expect(rpcCallCount).toBe(1);
  });

  it('fails fast when expected domain/chain config is missing in strict mode', async () => {
    expect(() => createGatewayServer({ rpcUrl })).toThrow(/expectedDomain and expectedChainId/);
    expect(() => createGatewayServer({ rpcUrl, expectedDomain: gatewayDomain })).toThrow(/expectedDomain and expectedChainId/);
    expect(() => createGatewayServer({ rpcUrl, expectedChainId: 1 })).toThrow(/expectedDomain and expectedChainId/);

    const app = createGatewayServer({
      rpcUrl,
      allowInsecureSiweEnv: true,
    });
    const agent = supertest(app);
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.parse(issuedAt) + sessionTtlMs).toISOString();
    const siweMessage = buildSiweMessage({
      address: wallet.address,
      sessionPubKeyHex: session.publicKeyHex,
      nonce: createNonce(),
      issuedAt,
      expirationTime,
      domain: 'local.dev',
      resources: boundResources,
    });
    const siweSignature = await wallet.signMessage(siweMessage);
    await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);
  });

  it('rejects session when SIWE domain mismatches expected domain', async () => {
    const app = createGatewayServer({
      rpcUrl,
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
    });
    const agent = supertest(app);
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.parse(issuedAt) + sessionTtlMs).toISOString();
    const siweMessage = buildSiweMessage({
      address: wallet.address,
      sessionPubKeyHex: session.publicKeyHex,
      nonce: createNonce(),
      issuedAt,
      expirationTime,
      domain: 'wrong.gateway.local',
      resources: boundResources,
    });
    const siweSignature = await wallet.signMessage(siweMessage);

    const response = await agent.post('/session').send({ siweMessage, siweSignature }).expect(400);
    expect(response.body?.error).toBe('SIWE domain mismatch');
  });

  it('rejects session when SIWE chainId mismatches expected chainId', async () => {
    const app = createGatewayServer({
      rpcUrl,
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
    });
    const agent = supertest(app);
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.parse(issuedAt) + sessionTtlMs).toISOString();
    const siweMessage = buildSiweMessage({
      address: wallet.address,
      sessionPubKeyHex: session.publicKeyHex,
      nonce: createNonce(),
      issuedAt,
      expirationTime,
      domain: gatewayDomain,
      chainId: 42161,
      resources: boundResources,
    });
    const siweSignature = await wallet.signMessage(siweMessage);

    const response = await agent.post('/session').send({ siweMessage, siweSignature }).expect(400);
    expect(response.body?.error).toBe('SIWE chainId mismatch');
  });

  it('accepts payload when decoded size is exactly at configured max', async () => {
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const siweMessage = buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });
    const siweSignature = await wallet.signMessage(siweMessage);
    const envelope = signEnvelope({
      metadata,
      message: { text: 'Boundary accepted', timestamp: Date.now() },
      senderAddress: wallet.address,
      sessionPrivKeyHex: session.privateKeyHex,
      sessionPubKeyHex: session.publicKeyHex,
    });
    const payloadBase64 = encodeEnvelopePayload(envelope);
    const maxMessagePayloadBytes = getDecodedPayloadBytes(payloadBase64);

    const app = createGatewayServer({
      rpcUrl,
      allowedTopics: [metadata.contentTopic],
      allowedPubsubTopics: [metadata.pubsubTopic],
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
      maxMessagePayloadBytes,
    });
    const agent = supertest(app);
    const sessionRes = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);

    await agent
      .post('/message')
      .send({
        sessionId: sessionRes.body.sessionId,
        contentTopic: metadata.contentTopic,
        pubsubTopic: metadata.pubsubTopic,
        payloadBase64,
      })
      .expect(200);

    expect(rpcCallCount).toBe(1);
  });

  it('rejects payload above configured max and does not relay', async () => {
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const siweMessage = buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });
    const siweSignature = await wallet.signMessage(siweMessage);
    const envelope = signEnvelope({
      metadata,
      message: { text: 'Boundary rejected', timestamp: Date.now() },
      senderAddress: wallet.address,
      sessionPrivKeyHex: session.privateKeyHex,
      sessionPubKeyHex: session.publicKeyHex,
    });
    const payloadBase64 = encodeEnvelopePayload(envelope);
    const payloadBytes = getDecodedPayloadBytes(payloadBase64);

    const app = createGatewayServer({
      rpcUrl,
      allowedTopics: [metadata.contentTopic],
      allowedPubsubTopics: [metadata.pubsubTopic],
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
      maxMessagePayloadBytes: payloadBytes - 1,
    });
    const agent = supertest(app);
    const sessionRes = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);

    const response = await agent
      .post('/message')
      .send({
        sessionId: sessionRes.body.sessionId,
        contentTopic: metadata.contentTopic,
        pubsubTopic: metadata.pubsubTopic,
        payloadBase64,
      })
      .expect(413);

    expect(response.body?.error).toContain('Payload too large');
    expect(response.body?.payloadBytes).toBe(payloadBytes);
    expect(response.body?.maxMessagePayloadBytes).toBe(payloadBytes - 1);
    expect(rpcCallCount).toBe(0);
    expect(lastRpcBody).toBeUndefined();
  });

  it('rejects sessions when topic bindings are missing', async () => {
    const app = createGatewayServer({
      rpcUrl,
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
      requireTopicBinding: true,
    });
    const agent = supertest(app);
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.parse(issuedAt) + sessionTtlMs).toISOString();
    const siweMessage = buildSiweMessage({
      address: wallet.address,
      sessionPubKeyHex: session.publicKeyHex,
      nonce: createNonce(),
      issuedAt,
      expirationTime,
      domain: gatewayDomain,
    });
    const siweSignature = await wallet.signMessage(siweMessage);

    const response = await agent.post('/session').send({ siweMessage, siweSignature }).expect(400);
    expect(response.body?.error).toContain('contentTopic');
  });

  it('rejects reused nonces', async () => {
    const app = createGatewayServer({
      rpcUrl,
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
    });
    const agent = supertest(app);
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.parse(issuedAt) + sessionTtlMs).toISOString();
    const nonce = createNonce();
    const siweMessage = buildSiweMessage({
      address: wallet.address,
      sessionPubKeyHex: session.publicKeyHex,
      nonce,
      issuedAt,
      expirationTime,
      domain: gatewayDomain,
      resources: boundResources,
    });
    const siweSignature = await wallet.signMessage(siweMessage);

    await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);
    const response = await agent.post('/session').send({ siweMessage, siweSignature }).expect(409);
    expect(response.body?.error).toContain('nonce');
  });

  it('rejects messages when session key differs', async () => {
    const app = createGatewayServer({
      rpcUrl,
      allowedTopics: [metadata.contentTopic],
      allowedPubsubTopics: [metadata.pubsubTopic],
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
    });
    const agent = supertest(app);
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const siweMessage = buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });
    const siweSignature = await wallet.signMessage(siweMessage);
    const { body } = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);

    const message = { text: 'Tampered', timestamp: Date.now() };
    const rogue = generateSessionKeypair();
    const envelope = signEnvelope({
      metadata,
      message,
      senderAddress: wallet.address,
      sessionPrivKeyHex: rogue.privateKeyHex,
      sessionPubKeyHex: rogue.publicKeyHex,
    });

    const payloadBase64 = encodeEnvelopePayload(envelope);
    await agent
      .post('/message')
      .send({ sessionId: body.sessionId, contentTopic: metadata.contentTopic, pubsubTopic: metadata.pubsubTopic, payloadBase64 })
      .expect(400);
    expect(lastRpcBody).toBeUndefined();
  });

  it('rejects sender-tampered envelopes even when attacker creates a matching session key record', async () => {
    const app = createGatewayServer({
      rpcUrl,
      allowedTopics: [metadata.contentTopic],
      allowedPubsubTopics: [metadata.pubsubTopic],
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
    });
    const agent = supertest(app);
    const originalSender = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const session = generateSessionKeypair();
    const siweMessage = buildBoundSiwe({
      address: attacker.address,
      sessionPubKeyHex: session.publicKeyHex,
    });
    const siweSignature = await attacker.signMessage(siweMessage);
    const { body } = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);

    const timestampMs = Date.now();
    const envelope = signEnvelope({
      metadata,
      message: { text: 'spoof-attempt', timestamp: timestampMs },
      senderAddress: originalSender.address,
      sessionPrivKeyHex: session.privateKeyHex,
      sessionPubKeyHex: session.publicKeyHex,
      timestampMs,
    });
    envelope.senderAddress = attacker.address;
    const payloadBase64 = encodeEnvelopePayload(envelope);

    const response = await agent
      .post('/message')
      .send({
        sessionId: body.sessionId,
        contentTopic: metadata.contentTopic,
        pubsubTopic: metadata.pubsubTopic,
        payloadBase64,
      })
      .expect(400);

    expect(response.body?.error).toBe('Invalid envelope signature');
    expect(lastRpcBody).toBeUndefined();
  });

  it('rejects legacy unsigned-sender envelopes', async () => {
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const siweMessage = buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });
    const siweSignature = await wallet.signMessage(siweMessage);
    const timestampMs = Date.now();
    const legacyEnvelope = signLegacyEnvelope({
      message: { text: 'legacy-envelope', timestamp: timestampMs },
      senderAddress: wallet.address,
      sessionPrivKeyHex: session.privateKeyHex,
      sessionPubKeyHex: session.publicKeyHex,
      timestampMs,
    });
    const payloadBase64 = encodeEnvelopePayload(legacyEnvelope);

    const strictApp = createGatewayServer({
      rpcUrl,
      allowedTopics: [metadata.contentTopic],
      allowedPubsubTopics: [metadata.pubsubTopic],
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
    });
    const strictAgent = supertest(strictApp);
    const strictSession = await strictAgent.post('/session').send({ siweMessage, siweSignature }).expect(200);
    const strictResponse = await strictAgent
      .post('/message')
      .send({
        sessionId: strictSession.body.sessionId,
        contentTopic: metadata.contentTopic,
        pubsubTopic: metadata.pubsubTopic,
        payloadBase64,
      })
      .expect(400);
    expect(strictResponse.body?.error).toBe('Invalid envelope signature');

  });

  it('rejects messages outside the allowed clock skew', async () => {
    const app = createGatewayServer({
      rpcUrl,
      allowedTopics: [metadata.contentTopic],
      allowedPubsubTopics: [metadata.pubsubTopic],
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
      maxClockSkewMs: 5 * 60 * 1000,
    });
    const agent = supertest(app);
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const siweMessage = buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });
    const siweSignature = await wallet.signMessage(siweMessage);
    const { body } = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);

    const staleTimestamp = Date.now() - 10 * 60 * 1000;
    const envelope = signEnvelope({
      metadata,
      message: { text: 'stale', timestamp: staleTimestamp },
      senderAddress: wallet.address,
      sessionPrivKeyHex: session.privateKeyHex,
      sessionPubKeyHex: session.publicKeyHex,
      timestampMs: staleTimestamp,
    });
    const payloadBase64 = encodeEnvelopePayload(envelope);

    const response = await agent
      .post('/message')
      .send({ sessionId: body.sessionId, contentTopic: metadata.contentTopic, pubsubTopic: metadata.pubsubTopic, payloadBase64 })
      .expect(400);
    expect(response.body?.error).toContain('Timestamp');
  });

  it('enforces per-address rate limits', async () => {
    const app = createGatewayServer({
      rpcUrl,
      allowedTopics: [metadata.contentTopic],
      allowedPubsubTopics: [metadata.pubsubTopic],
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
      rateLimit: 1,
      rateLimitWindowMs: 60_000,
    });
    const agent = supertest(app);
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const siweMessage = buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });
    const siweSignature = await wallet.signMessage(siweMessage);
    const { body } = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);

    const makePayload = (note: string, offsetMs = 0) => {
      const base = Date.now() + offsetMs;
      const envelope = signEnvelope({
        metadata,
        message: { text: note, timestamp: base },
        senderAddress: wallet.address,
        sessionPrivKeyHex: session.privateKeyHex,
        sessionPubKeyHex: session.publicKeyHex,
        timestampMs: base,
      });
      return encodeEnvelopePayload(envelope);
    };

    await agent
      .post('/message')
      .send({ sessionId: body.sessionId, contentTopic: metadata.contentTopic, pubsubTopic: metadata.pubsubTopic, payloadBase64: makePayload('first') })
      .expect(200);
    expect(rpcCallCount).toBe(1);

    await agent
      .post('/message')
      .send({ sessionId: body.sessionId, contentTopic: metadata.contentTopic, pubsubTopic: metadata.pubsubTopic, payloadBase64: makePayload('second', 10) })
      .expect(429);
    expect(rpcCallCount).toBe(1);
  });

  it('rejects duplicate message IDs', async () => {
    const app = createGatewayServer({
      rpcUrl,
      allowedTopics: [metadata.contentTopic],
      allowedPubsubTopics: [metadata.pubsubTopic],
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
      messageIdTtlMs: 5 * 60 * 1000,
    });
    const agent = supertest(app);
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const siweMessage = buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });
    const siweSignature = await wallet.signMessage(siweMessage);
    const { body } = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);

    const envelope = signEnvelope({
      metadata,
      message: { text: 'duplicate', timestamp: Date.now() },
      senderAddress: wallet.address,
      sessionPrivKeyHex: session.privateKeyHex,
      sessionPubKeyHex: session.publicKeyHex,
      timestampMs: Date.now(),
    });
    const payloadBase64 = encodeEnvelopePayload(envelope);

    await agent
      .post('/message')
      .send({ sessionId: body.sessionId, contentTopic: metadata.contentTopic, pubsubTopic: metadata.pubsubTopic, payloadBase64 })
      .expect(200);
    expect(rpcCallCount).toBe(1);

    await agent
      .post('/message')
      .send({ sessionId: body.sessionId, contentTopic: metadata.contentTopic, pubsubTopic: metadata.pubsubTopic, payloadBase64 })
      .expect(409);
    expect(rpcCallCount).toBe(1);
  });

  it('enforces minimum token balance using injected provider', async () => {
    const balanceProvider = vi.fn().mockResolvedValue(BigInt('0x1000000000000000'));
    const app = createGatewayServer({
      rpcUrl,
      allowedTopics: [metadata.contentTopic],
      allowedPubsubTopics: [metadata.pubsubTopic],
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
      minBalanceWei: BigInt('0x0f00000000000000'),
      balanceProvider,
      balanceCacheTtlMs: 60_000,
    });
    const agent = supertest(app);
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();
    const siweMessage = buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });
    const siweSignature = await wallet.signMessage(siweMessage);
    const { body } = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);

    const sendMessage = async (text: string, offset = 0) => {
      const base = Date.now() + offset;
      const envelope = signEnvelope({
        metadata,
        message: { text, timestamp: base },
        senderAddress: wallet.address,
        sessionPrivKeyHex: session.privateKeyHex,
        sessionPubKeyHex: session.publicKeyHex,
        timestampMs: base,
      });
      const payloadBase64 = encodeEnvelopePayload(envelope);
      return agent
        .post('/message')
        .send({ sessionId: body.sessionId, contentTopic: metadata.contentTopic, pubsubTopic: metadata.pubsubTopic, payloadBase64 })
        .expect(200);
    };

    await sendMessage('ok-1');
    await sendMessage('ok-2', 5);
    expect(balanceProvider).toHaveBeenCalledTimes(1);
  });

  it('rejects when balance below threshold unless allowlisted', async () => {
    const lowBalanceProvider = vi.fn().mockResolvedValue(BigInt(0));
    const wallet = Wallet.createRandom();
    const session = generateSessionKeypair();

    const configBase: GatewayConfig = {
      rpcUrl,
      allowedTopics: [metadata.contentTopic],
      allowedPubsubTopics: [metadata.pubsubTopic],
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
      minBalanceWei: BigInt(1),
      balanceProvider: lowBalanceProvider,
    };

    const buildSiwe = () => buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });

    const envelopePayload = () => {
      const base = Date.now();
      const envelope = signEnvelope({
        metadata,
        message: { text: 'gated', timestamp: base },
        senderAddress: wallet.address,
        sessionPrivKeyHex: session.privateKeyHex,
        sessionPubKeyHex: session.publicKeyHex,
        timestampMs: base,
      });
      return encodeEnvelopePayload(envelope);
    };

    // Non-allowlisted -> reject
    let app = createGatewayServer(configBase);
    let agent = supertest(app);
    let siweMessage = buildSiwe();
    let siweSignature = await wallet.signMessage(siweMessage);
    let { body } = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);
    await agent
      .post('/message')
      .send({ sessionId: body.sessionId, contentTopic: metadata.contentTopic, pubsubTopic: metadata.pubsubTopic, payloadBase64: envelopePayload() })
      .expect(403);

    // Allowlisted -> passes even with low balance
    app = createGatewayServer({ ...configBase, allowlist: [wallet.address] });
    agent = supertest(app);
    siweMessage = buildSiwe();
    siweSignature = await wallet.signMessage(siweMessage);
    const sessionRes = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);
    await agent
      .post('/message')
      .send({ sessionId: sessionRes.body.sessionId, contentTopic: metadata.contentTopic, pubsubTopic: metadata.pubsubTopic, payloadBase64: envelopePayload() })
      .expect(200);
  });

  it('exposes reject counters and publish counters via /metrics', async () => {
    const app = createGatewayServer({
      rpcUrl,
      expectedDomain: gatewayDomain,
      expectedChainId: 1,
    });
    const agent = supertest(app);

    await agent.post('/session').send({}).expect(400);
    await agent.post('/message').send({}).expect(400);

    const metrics = await agent.get('/metrics').expect(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.text).toContain('gateway_reject_total{endpoint="/session",reason="missing_siwe_fields"} 1');
    expect(metrics.text).toContain('gateway_reject_total{endpoint="/message",reason="missing_required_fields"} 1');
    expect(metrics.text).toContain('gateway_publish_total{outcome="success"} 0');
    expect(metrics.text).toContain('gateway_publish_total{outcome="failure"} 0');
    expect(metrics.text).not.toContain('reason="unknown_session"} 1');
  });

  it('emits structured publish success telemetry for /message', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = createGatewayServer({
        rpcUrl,
        allowedTopics: [metadata.contentTopic],
        allowedPubsubTopics: [metadata.pubsubTopic],
        expectedDomain: gatewayDomain,
        expectedChainId: 1,
      });
      const agent = supertest(app);
      const wallet = Wallet.createRandom();
      const session = generateSessionKeypair();
      const siweMessage = buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });
      const siweSignature = await wallet.signMessage(siweMessage);
      const sessionRes = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);

      const envelope = signEnvelope({
        metadata,
        message: { text: 'Telemetry success', timestamp: Date.now() },
        senderAddress: wallet.address,
        sessionPrivKeyHex: session.privateKeyHex,
        sessionPubKeyHex: session.publicKeyHex,
      });
      const payloadBase64 = encodeEnvelopePayload(envelope);

      await agent
        .post('/message')
        .send({
          sessionId: sessionRes.body.sessionId,
          contentTopic: metadata.contentTopic,
          pubsubTopic: metadata.pubsubTopic,
          payloadBase64,
        })
        .expect(200);

      const publishEvents = parseJsonLogEvents(infoSpy.mock.calls).filter((event) => event.event === 'gateway.publish');
      expect(publishEvents.length).toBeGreaterThan(0);
      expect(publishEvents[0]).toMatchObject({
        endpoint: '/message',
        outcome: 'success',
        transport: 'rpc',
      });
      expect(typeof publishEvents[0].latencyMs).toBe('number');
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('emits structured publish failure telemetry and increments failure counters', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createGatewayServer({
        rpcUrl: 'http://127.0.0.1:1',
        allowedTopics: [metadata.contentTopic],
        allowedPubsubTopics: [metadata.pubsubTopic],
        expectedDomain: gatewayDomain,
        expectedChainId: 1,
      });
      const agent = supertest(app);
      const wallet = Wallet.createRandom();
      const session = generateSessionKeypair();
      const siweMessage = buildBoundSiwe({ address: wallet.address, sessionPubKeyHex: session.publicKeyHex });
      const siweSignature = await wallet.signMessage(siweMessage);
      const sessionRes = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);

      const envelope = signEnvelope({
        metadata,
        message: { text: 'Telemetry failure', timestamp: Date.now() },
        senderAddress: wallet.address,
        sessionPrivKeyHex: session.privateKeyHex,
        sessionPubKeyHex: session.publicKeyHex,
      });
      const payloadBase64 = encodeEnvelopePayload(envelope);

      const response = await agent
        .post('/message')
        .send({
          sessionId: sessionRes.body.sessionId,
          contentTopic: metadata.contentTopic,
          pubsubTopic: metadata.pubsubTopic,
          payloadBase64,
        })
        .expect(502);

      expect(response.body.error).toBe('RPC call failed');
      const publishEvents = parseJsonLogEvents(errorSpy.mock.calls).filter((event) => event.event === 'gateway.publish');
      expect(publishEvents.length).toBeGreaterThan(0);
      expect(publishEvents[0]).toMatchObject({
        endpoint: '/message',
        outcome: 'failure',
        transport: 'rpc',
      });
      expect(typeof publishEvents[0].latencyMs).toBe('number');

      const metrics = await agent.get('/metrics').expect(200);
      expect(metrics.text).toContain('gateway_publish_total{outcome="success"} 0');
      expect(metrics.text).toContain('gateway_publish_total{outcome="failure"} 1');
      expect(metrics.text).toContain('gateway_reject_total{endpoint="/message",reason="publish_failed"} 1');
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('polyfills WebSocket runtime for js-waku in node', async () => {
    const hasWebSocket = 'WebSocket' in globalThis;
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    const originalValue = (globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket;

    try {
      if (!originalDescriptor || originalDescriptor.configurable) {
        Object.defineProperty(globalThis, 'WebSocket', {
          value: undefined,
          writable: true,
          configurable: true,
        });
      } else if (originalDescriptor.writable) {
        (globalThis as any).WebSocket = undefined;
      } else {
        // Cannot override non-configurable/non-writable globals in this runtime.
        // Ensure helper still succeeds with the existing runtime.
        await expect(__gatewayTestUtils.ensureJsWakuRuntime()).resolves.toBeUndefined();
        expect(typeof (globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket).toBe('function');
        return;
      }

      await expect(__gatewayTestUtils.ensureJsWakuRuntime()).resolves.toBeUndefined();
      expect(typeof (globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket).toBe('function');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'WebSocket', originalDescriptor);
      } else if (hasWebSocket) {
        (globalThis as any).WebSocket = originalValue;
      } else {
        delete (globalThis as any).WebSocket;
      }
    }
  });
});
