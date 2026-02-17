import { webcrypto } from 'node:crypto';
import { Wallet } from 'ethers';
import {
  buildSiweMessage,
  createNonce,
  encodeEnvelopePayload,
  generateSessionKeypair,
  signEnvelope,
} from '../src/waku/auth/session';

if (typeof globalThis.crypto === 'undefined') {
  (globalThis as typeof globalThis & { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

type SmokeConfig = {
  gatewayBaseUrl: string;
  domain: string;
  chainId: number;
  contentTopic: string;
  pubsubTopic: string;
  sessionTtlMs: number;
  walletPrivateKey?: string;
};

type StageErrorParams = {
  stage: string;
  message: string;
  status?: number;
  detail?: string;
};

class StageError extends Error {
  stage: string;
  status?: number;
  detail?: string;

  constructor(params: StageErrorParams) {
    super(params.message);
    this.name = 'StageError';
    this.stage = params.stage;
    this.status = params.status;
    this.detail = params.detail;
  }
}

function parseNumber(value?: string) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseGatewayBaseUrl(value: string) {
  const url = new URL(value);
  return url.href.replace(/\/+$/, '');
}

function getConfig(): SmokeConfig {
  const gatewayBaseUrl = parseGatewayBaseUrl(
    process.env.LP_SMOKE_GATEWAY_URL ??
      process.env.VITE_LIGHTPUSH_GATEWAY_URL ??
      'http://localhost:8787',
  );

  const parsedGateway = new URL(gatewayBaseUrl);
  const domain = process.env.LP_SMOKE_DOMAIN ?? process.env.LP_DOMAIN ?? parsedGateway.hostname;
  const chainId = parseNumber(process.env.LP_SMOKE_CHAIN_ID ?? process.env.LP_CHAIN_ID) ?? 1;
  const contentTopic = process.env.LP_SMOKE_CONTENT_TOPIC ?? '/waku-auth-lite/1/chat/json';
  const pubsubTopic = process.env.LP_SMOKE_PUBSUB_TOPIC ?? '/waku/2/rs/999/0';
  const sessionTtlMs = parseNumber(process.env.LP_SMOKE_SESSION_TTL_MS) ?? 60 * 60 * 1000;
  const walletPrivateKey = process.env.LP_SMOKE_WALLET_PRIVATE_KEY;

  return {
    gatewayBaseUrl,
    domain,
    chainId,
    contentTopic,
    pubsubTopic,
    sessionTtlMs,
    walletPrivateKey,
  };
}

function summarizeBody(rawBody: string) {
  if (!rawBody) return '';
  const normalized = rawBody.replace(/\s+/g, ' ').trim();
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

async function getHealth(baseUrl: string) {
  const stage = '/healthz';
  try {
    const response = await fetch(`${baseUrl}/healthz`);
    if (!response.ok) {
      const detail = summarizeBody(await response.text());
      throw new StageError({
        stage,
        message: 'Health check failed',
        status: response.status,
        detail,
      });
    }
    return response.json().catch(() => ({}));
  } catch (error) {
    if (error instanceof StageError) throw error;
    throw new StageError({
      stage,
      message: `Health check request failed: ${(error as Error).message}`,
    });
  }
}

async function postJson<TResponse>(params: {
  baseUrl: string;
  path: '/session' | '/message';
  body: Record<string, unknown>;
}): Promise<TResponse> {
  const stage = params.path;
  try {
    const response = await fetch(`${params.baseUrl}${params.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params.body),
    });

    const rawBody = await response.text();
    const detail = summarizeBody(rawBody);

    if (!response.ok) {
      throw new StageError({
        stage,
        message: `${stage} returned ${response.status}`,
        status: response.status,
        detail,
      });
    }

    return (rawBody ? JSON.parse(rawBody) : {}) as TResponse;
  } catch (error) {
    if (error instanceof StageError) throw error;
    throw new StageError({
      stage,
      message: `${stage} request failed: ${(error as Error).message}`,
    });
  }
}

function logConfig(config: SmokeConfig) {
  console.log('Gateway smoke test config:');
  console.log(`  gateway: ${config.gatewayBaseUrl}`);
  console.log(`  domain: ${config.domain}`);
  console.log(`  chainId: ${config.chainId}`);
  console.log(`  contentTopic: ${config.contentTopic}`);
  console.log(`  pubsubTopic: ${config.pubsubTopic}`);
}

async function main() {
  const config = getConfig();
  logConfig(config);

  const health = await getHealth(config.gatewayBaseUrl);
  console.log(`[OK] /healthz ${JSON.stringify(health)}`);

  const wallet = config.walletPrivateKey
    ? new Wallet(config.walletPrivateKey)
    : Wallet.createRandom();
  const sessionKeypair = generateSessionKeypair();
  const issuedAtMs = Date.now();
  const issuedAt = new Date(issuedAtMs).toISOString();
  const expirationTime = new Date(issuedAtMs + config.sessionTtlMs).toISOString();
  const siweMessage = buildSiweMessage({
    address: wallet.address,
    sessionPubKeyHex: sessionKeypair.publicKeyHex,
    nonce: createNonce(),
    issuedAt,
    expirationTime,
    chainId: config.chainId,
    domain: config.domain,
    resources: [
      `urn:waku:contentTopic:${config.contentTopic}`,
      `urn:waku:pubsubTopic:${config.pubsubTopic}`,
    ],
  });
  const siweSignature = await wallet.signMessage(siweMessage);

  const sessionResponse = await postJson<{ sessionId: string; expiresAt?: string }>({
    baseUrl: config.gatewayBaseUrl,
    path: '/session',
    body: {
      siweMessage,
      siweSignature,
      allowedTopics: [config.contentTopic],
      allowedPubsubTopics: [config.pubsubTopic],
    },
  });

  if (!sessionResponse.sessionId) {
    throw new StageError({
      stage: '/session',
      message: 'Session response did not include sessionId',
      detail: JSON.stringify(sessionResponse),
    });
  }
  console.log(
    `[OK] /session sessionId=${sessionResponse.sessionId.slice(0, 12)}... expiresAt=${sessionResponse.expiresAt ?? 'n/a'}`,
  );

  const metadata = {
    contentTopic: config.contentTopic,
    pubsubTopic: config.pubsubTopic,
  };
  const envelope = signEnvelope({
    metadata,
    message: {
      text: 'gateway-session-message-smoke-test',
      timestamp: Date.now(),
    },
    senderAddress: wallet.address,
    sessionPrivKeyHex: sessionKeypair.privateKeyHex,
    sessionPubKeyHex: sessionKeypair.publicKeyHex,
  });

  const messageResponse = await postJson<{ ok?: boolean; relay?: unknown }>({
    baseUrl: config.gatewayBaseUrl,
    path: '/message',
    body: {
      sessionId: sessionResponse.sessionId,
      contentTopic: config.contentTopic,
      pubsubTopic: config.pubsubTopic,
      payloadBase64: encodeEnvelopePayload(envelope),
    },
  });

  if (!messageResponse.ok) {
    throw new StageError({
      stage: '/message',
      message: 'Message response did not include ok=true',
      detail: JSON.stringify(messageResponse),
    });
  }
  console.log('[OK] /message relay publish accepted');
  console.log('Smoke test passed.');
}

main().catch((error) => {
  if (error instanceof StageError) {
    const status = typeof error.status === 'number' ? ` status=${error.status}` : '';
    const detail = error.detail ? ` body=${error.detail}` : '';
    console.error(`[FAIL] ${error.stage}${status}: ${error.message}${detail}`);
  } else {
    console.error(`[FAIL] unexpected: ${(error as Error).message}`);
  }
  process.exitCode = 1;
});
