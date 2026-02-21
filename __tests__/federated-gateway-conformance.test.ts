import { afterAll, describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import supertest from 'supertest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildSiweMessage,
  createNonce,
  encodeEnvelopePayload,
  generateSessionKeypair,
  signEnvelope,
} from '../src/waku/auth/session';
import { createGatewayServer } from '../src/waku/gateway/server';

const metadata = {
  contentTopic: '/waku-auth-lite/1/chat/json',
  pubsubTopic: '/waku/2/rs/999/0',
};
const gatewayDomain = 'gateway.local';
const rpcUrl = 'http://127.0.0.1:18000';
const sessionTtlMs = 60 * 60 * 1000;
const reproCommand = process.env.FEDERATED_CONFORMANCE_REPRO_COMMAND || 'pnpm security:federated:conformance';
const reportPath = process.env.FEDERATED_CONFORMANCE_REPORT_PATH || 'security/reports/federated-gateway-conformance-report.json';

type ConformanceCase = {
  invariantId: string;
  profileId: string;
  title: string;
  run: () => Promise<void>;
};

type ConformanceResult = {
  invariantId: string;
  profileId: string;
  title: string;
  status: 'pass' | 'fail';
  durationMs: number;
  error?: string;
};

const results: ConformanceResult[] = [];

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildSiweForGateway(params: {
  address: string;
  sessionPubKeyHex: string;
  domain?: string;
  chainId?: number;
  nonce?: string;
}) {
  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(Date.parse(issuedAt) + sessionTtlMs).toISOString();
  return buildSiweMessage({
    address: params.address,
    sessionPubKeyHex: params.sessionPubKeyHex,
    nonce: params.nonce || createNonce(),
    issuedAt,
    expirationTime,
    domain: params.domain || gatewayDomain,
    chainId: params.chainId ?? 1,
    resources: [
      `urn:waku:contentTopic:${metadata.contentTopic}`,
      `urn:waku:pubsubTopic:${metadata.pubsubTopic}`,
    ],
  });
}

async function createStrictSession(agent: ReturnType<typeof supertest>, wallet = Wallet.createRandom()) {
  const session = generateSessionKeypair();
  const siweMessage = buildSiweForGateway({
    address: wallet.address,
    sessionPubKeyHex: session.publicKeyHex,
  });
  const siweSignature = await wallet.signMessage(siweMessage);
  const response = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);
  return { wallet, session, sessionId: response.body.sessionId as string };
}

describe('federated gateway security conformance', () => {
  afterAll(async () => {
    const passCount = results.filter((result) => result.status === 'pass').length;
    const failCount = results.length - passCount;
    const report = {
      schemaVersion: 1,
      suite: 'federated-gateway-security-conformance',
      generatedAt: new Date().toISOString(),
      reproductionCommand: reproCommand,
      summary: {
        total: results.length,
        pass: passCount,
        fail: failCount,
      },
      results,
    };
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  });

  const cases: ConformanceCase[] = [
    {
      invariantId: 'siwe_domain_mismatch_reject',
      profileId: 'strict-default',
      title: 'rejects session when SIWE domain mismatches expected domain',
      run: async () => {
        const app = createGatewayServer({
          rpcUrl,
          expectedDomain: gatewayDomain,
          expectedChainId: 1,
        });
        const agent = supertest(app);
        const wallet = Wallet.createRandom();
        const session = generateSessionKeypair();
        const siweMessage = buildSiweForGateway({
          address: wallet.address,
          sessionPubKeyHex: session.publicKeyHex,
          domain: 'wrong.gateway.local',
        });
        const siweSignature = await wallet.signMessage(siweMessage);
        const response = await agent.post('/session').send({ siweMessage, siweSignature }).expect(400);
        expect(response.body?.error).toBe('SIWE domain mismatch');
      },
    },
    {
      invariantId: 'siwe_chain_mismatch_reject',
      profileId: 'strict-default',
      title: 'rejects session when SIWE chainId mismatches expected chainId',
      run: async () => {
        const app = createGatewayServer({
          rpcUrl,
          expectedDomain: gatewayDomain,
          expectedChainId: 1,
        });
        const agent = supertest(app);
        const wallet = Wallet.createRandom();
        const session = generateSessionKeypair();
        const siweMessage = buildSiweForGateway({
          address: wallet.address,
          sessionPubKeyHex: session.publicKeyHex,
          chainId: 42161,
        });
        const siweSignature = await wallet.signMessage(siweMessage);
        const response = await agent.post('/session').send({ siweMessage, siweSignature }).expect(400);
        expect(response.body?.error).toBe('SIWE chainId mismatch');
      },
    },
    {
      invariantId: 'topic_mismatch_reject',
      profileId: 'strict-default',
      title: 'rejects message publish for disallowed content topic',
      run: async () => {
        const app = createGatewayServer({
          rpcUrl,
          allowedTopics: [metadata.contentTopic],
          allowedPubsubTopics: [metadata.pubsubTopic],
          expectedDomain: gatewayDomain,
          expectedChainId: 1,
        });
        const agent = supertest(app);
        const { wallet, session, sessionId } = await createStrictSession(agent);
        const envelope = signEnvelope({
          metadata,
          message: { text: 'topic mismatch', timestamp: Date.now() },
          senderAddress: wallet.address,
          sessionPrivKeyHex: session.privateKeyHex,
          sessionPubKeyHex: session.publicKeyHex,
        });
        const payloadBase64 = encodeEnvelopePayload(envelope);
        const response = await agent
          .post('/message')
          .send({
            sessionId,
            contentTopic: '/waku-auth-lite/1/disallowed-topic/json',
            pubsubTopic: metadata.pubsubTopic,
            payloadBase64,
          })
          .expect(403);
        expect(response.body?.error).toBe('Topic not allowed');
      },
    },
    {
      invariantId: 'sender_binding_mismatch_reject',
      profileId: 'strict-default',
      title: 'rejects sender-bound envelope tampering',
      run: async () => {
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
        const siweMessage = buildSiweForGateway({
          address: attacker.address,
          sessionPubKeyHex: session.publicKeyHex,
        });
        const siweSignature = await attacker.signMessage(siweMessage);
        const sessionRes = await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);
        const envelope = signEnvelope({
          metadata,
          message: { text: 'sender-bound test', timestamp: Date.now() },
          senderAddress: originalSender.address,
          sessionPrivKeyHex: session.privateKeyHex,
          sessionPubKeyHex: session.publicKeyHex,
        });
        envelope.senderAddress = attacker.address;
        const payloadBase64 = encodeEnvelopePayload(envelope);
        const response = await agent
          .post('/message')
          .send({
            sessionId: sessionRes.body.sessionId,
            contentTopic: metadata.contentTopic,
            pubsubTopic: metadata.pubsubTopic,
            payloadBase64,
          })
          .expect(400);
        expect(response.body?.error).toBe('Invalid envelope signature');
      },
    },
    {
      invariantId: 'siwe_nonce_replay_reject',
      profileId: 'strict-default',
      title: 'rejects replayed SIWE nonce',
      run: async () => {
        const app = createGatewayServer({
          rpcUrl,
          expectedDomain: gatewayDomain,
          expectedChainId: 1,
        });
        const agent = supertest(app);
        const wallet = Wallet.createRandom();
        const session = generateSessionKeypair();
        const nonce = createNonce();
        const siweMessage = buildSiweForGateway({
          address: wallet.address,
          sessionPubKeyHex: session.publicKeyHex,
          nonce,
        });
        const siweSignature = await wallet.signMessage(siweMessage);
        await agent.post('/session').send({ siweMessage, siweSignature }).expect(200);
        const replay = await agent.post('/session').send({ siweMessage, siweSignature }).expect(409);
        expect(String(replay.body?.error || '')).toContain('nonce');
      },
    },
    {
      invariantId: 'authlite_fail_closed_config',
      profileId: 'strict-default',
      title: 'fails closed when strict SIWE env config is missing',
      run: async () => {
        expect(() => createGatewayServer({ rpcUrl })).toThrow(/expectedDomain and expectedChainId/);
      },
    },
  ];

  for (const conformanceCase of cases) {
    it(`[profile:${conformanceCase.profileId}] [invariant:${conformanceCase.invariantId}] ${conformanceCase.title}`, async () => {
      const start = Date.now();
      try {
        await conformanceCase.run();
        results.push({
          invariantId: conformanceCase.invariantId,
          profileId: conformanceCase.profileId,
          title: conformanceCase.title,
          status: 'pass',
          durationMs: Date.now() - start,
        });
      } catch (error) {
        results.push({
          invariantId: conformanceCase.invariantId,
          profileId: conformanceCase.profileId,
          title: conformanceCase.title,
          status: 'fail',
          durationMs: Date.now() - start,
          error: toErrorMessage(error),
        });
        throw error;
      }
    });
  }
});
