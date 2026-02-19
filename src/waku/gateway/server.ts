import express from 'express';
import type { Request, Response } from 'express';
import {
  decodeEnvelopePayload,
  deriveSessionId,
  EnvelopeMetadata,
  extractTopicBindings,
  SessionRecord,
  SignedEnvelope,
  verifyEnvelope,
  verifySiweAuthorization,
} from '../auth/session';

export interface GatewayConfig {
  rpcUrl: string;
  balanceRpcUrl?: string;
  publishTransport?: 'auto' | 'rpc' | 'lightpush';
  lightpushPeerId?: string;
  lightpushWsUrl?: string;
  lightpushConnectTimeoutMs?: number;
  allowedTopics?: string[];
  allowedPubsubTopics?: string[];
  expectedDomain?: string;
  expectedChainId?: number;
  allowInsecureSiweEnv?: boolean;
  maxSiweClockSkewMs?: number;
  minSessionTtlMs?: number;
  maxSessionTtlMs?: number;
  nonceTtlMs?: number;
  nonceStore?: NonceStore;
  requireTopicBinding?: boolean;
  bodyLimit?: string;
  maxMessagePayloadBytes?: number;
  maxClockSkewMs?: number;
  sessionStore?: SessionStore;
  sessionStoreMaxEntries?: number;
  nonceStoreMaxEntries?: number;
  rateLimitMaxEntries?: number;
  messageDeduperMaxEntries?: number;
  balanceCacheMaxEntries?: number;
  rateLimit?: number;
  rateLimitWindowMs?: number;
  messageIdTtlMs?: number;
  minBalanceWei?: string | number | bigint;
  balanceCacheTtlMs?: number;
  allowlist?: string[];
  denylist?: string[];
  balanceProvider?: (address: string) => Promise<bigint>;
}

export interface SessionStore {
  get(id: string): SessionRecord | undefined;
  set(id: string, value: SessionRecord): boolean;
  delete(id: string): void;
}

export interface NonceStore {
  consume(nonce: string, expiresAtMs: number): 'consumed' | 'reused' | 'saturated';
}

const DEFAULT_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_RATE_LIMIT = 5;
const DEFAULT_RATE_WINDOW_MS = 30 * 1000;
const DEFAULT_MESSAGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_BALANCE_CACHE_MS = 2 * 60 * 1000;
const DEFAULT_SESSION_STORE_MAX_ENTRIES = 5_000;
const DEFAULT_NONCE_STORE_MAX_ENTRIES = 10_000;
const DEFAULT_RATE_LIMITER_MAX_ENTRIES = 20_000;
const DEFAULT_MESSAGE_DEDUPER_MAX_ENTRIES = 20_000;
const DEFAULT_BALANCE_CACHE_MAX_ENTRIES = 10_000;
const DEFAULT_SIWE_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MIN_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_TTL_MAX_MS = 60 * 60 * 1000;
const DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES = 32 * 1024;
type GatewayEndpoint = '/session' | '/message';
type PublishTransport = 'lightpush' | 'rpc' | 'rpc-fallback' | 'unknown';
type StoreName = 'session' | 'nonce' | 'rate_limiter' | 'message_dedupe' | 'balance_cache';
type StoreEvictionReason = 'expired' | 'capacity';

const REJECT_REASON = {
  MISSING_SIWE_FIELDS: 'missing_siwe_fields',
  SIWE_DOMAIN_MISMATCH: 'siwe_domain_mismatch',
  SIWE_CHAIN_ID_MISMATCH: 'siwe_chain_id_mismatch',
  SIWE_ISSUED_IN_FUTURE: 'siwe_issued_in_future',
  SIWE_EXPIRED: 'siwe_expired',
  SIWE_TTL_OUT_OF_BOUNDS: 'siwe_ttl_out_of_bounds',
  SIWE_NONCE_MISSING: 'siwe_nonce_missing',
  SIWE_NONCE_EXPIRED: 'siwe_nonce_expired',
  SIWE_NONCE_REUSED: 'siwe_nonce_reused',
  NONCE_STORE_SATURATED: 'nonce_store_saturated',
  SESSION_STORE_SATURATED: 'session_store_saturated',
  SIWE_TOPIC_BINDING_INVALID: 'siwe_topic_binding_invalid',
  SIWE_VALIDATION_FAILED: 'siwe_validation_failed',
  MISSING_REQUIRED_FIELDS: 'missing_required_fields',
  INVALID_PAYLOAD: 'invalid_payload',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  UNKNOWN_SESSION: 'unknown_session',
  SESSION_EXPIRED: 'session_expired',
  TOPIC_NOT_ALLOWED: 'topic_not_allowed',
  PUBSUB_TOPIC_NOT_ALLOWED: 'pubsub_topic_not_allowed',
  SESSION_KEY_MISMATCH: 'session_key_mismatch',
  SENDER_MISMATCH: 'sender_mismatch',
  INVALID_ENVELOPE_SIGNATURE: 'invalid_envelope_signature',
  TIMESTAMP_OUT_OF_SKEW: 'timestamp_out_of_skew',
  DUPLICATE_MESSAGE_ID: 'duplicate_message_id',
  RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
  INSUFFICIENT_BALANCE: 'insufficient_balance',
  PUBLISH_FAILED: 'publish_failed',
  MESSAGE_VALIDATION_FAILED: 'message_validation_failed',
} as const;

type RejectReason = (typeof REJECT_REASON)[keyof typeof REJECT_REASON];

function inferSaturatedStore(reason: RejectReason): StoreName | undefined {
  if (reason === REJECT_REASON.NONCE_STORE_SATURATED) return 'nonce';
  if (reason === REJECT_REASON.SESSION_STORE_SATURATED) return 'session';
  return undefined;
}

function createGatewayMetricsRegistry() {
  const rejectCounters = new Map<string, number>();
  const storeSaturationCounters = new Map<string, number>();
  const storeEvictionCounters = new Map<string, number>();
  const publishCounters = {
    success: 0,
    failure: 0,
  };
  return {
    incrementReject(endpoint: GatewayEndpoint, reason: RejectReason) {
      const key = `${endpoint}\u0000${reason}`;
      rejectCounters.set(key, (rejectCounters.get(key) ?? 0) + 1);
    },
    incrementPublish(outcome: 'success' | 'failure') {
      publishCounters[outcome] += 1;
    },
    incrementStoreSaturation(store: StoreName, endpoint: GatewayEndpoint) {
      const key = `${store}\u0000${endpoint}`;
      storeSaturationCounters.set(key, (storeSaturationCounters.get(key) ?? 0) + 1);
      console.warn(
        JSON.stringify({
          event: 'gateway.store_pressure',
          kind: 'saturation',
          store,
          endpoint,
        }),
      );
    },
    incrementStoreEviction(store: StoreName, reason: StoreEvictionReason, count = 1) {
      if (count <= 0) return;
      const key = `${store}\u0000${reason}`;
      storeEvictionCounters.set(key, (storeEvictionCounters.get(key) ?? 0) + count);
      console.info(
        JSON.stringify({
          event: 'gateway.store_pressure',
          kind: 'eviction',
          store,
          reason,
          count,
        }),
      );
    },
    toPrometheusText() {
      const lines = [
        '# HELP gateway_reject_total Total gateway request rejections grouped by endpoint and reason.',
        '# TYPE gateway_reject_total counter',
      ];
      for (const [key, count] of [...rejectCounters.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const [endpoint, reason] = key.split('\u0000');
        lines.push(
          `gateway_reject_total{endpoint="${escapeMetricLabel(endpoint)}",reason="${escapeMetricLabel(reason)}"} ${count}`,
        );
      }
      lines.push('# HELP gateway_publish_total Total gateway publish outcomes grouped by outcome.');
      lines.push('# TYPE gateway_publish_total counter');
      lines.push(`gateway_publish_total{outcome="success"} ${publishCounters.success}`);
      lines.push(`gateway_publish_total{outcome="failure"} ${publishCounters.failure}`);
      lines.push('# HELP gateway_store_saturation_total Total store saturation events grouped by store and endpoint.');
      lines.push('# TYPE gateway_store_saturation_total counter');
      for (const [key, count] of [...storeSaturationCounters.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const [store, endpoint] = key.split('\u0000');
        lines.push(
          `gateway_store_saturation_total{store="${escapeMetricLabel(store)}",endpoint="${escapeMetricLabel(endpoint)}"} ${count}`,
        );
      }
      lines.push('# HELP gateway_store_eviction_total Total bounded-store evictions grouped by store and reason.');
      lines.push('# TYPE gateway_store_eviction_total counter');
      for (const [key, count] of [...storeEvictionCounters.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const [store, reason] = key.split('\u0000');
        lines.push(
          `gateway_store_eviction_total{store="${escapeMetricLabel(store)}",reason="${escapeMetricLabel(reason)}"} ${count}`,
        );
      }
      return `${lines.join('\n')}\n`;
    },
  };
}

function escapeMetricLabel(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function inferSessionValidationReason(errorMessage: string): RejectReason {
  if (errorMessage.includes('contentTopic') || errorMessage.includes('pubsubTopic')) {
    return REJECT_REASON.SIWE_TOPIC_BINDING_INVALID;
  }
  return REJECT_REASON.SIWE_VALIDATION_FAILED;
}

function inferPublishTransport(result: unknown, fallback: PublishTransport): PublishTransport {
  if (result && typeof result === 'object' && 'transport' in result && typeof (result as { transport?: unknown }).transport === 'string') {
    const transport = (result as { transport: string }).transport;
    if (transport === 'lightpush' || transport === 'rpc' || transport === 'rpc-fallback') {
      return transport;
    }
  }
  return fallback;
}

export function createInMemorySessionStore(options?: {
  maxEntries?: number;
  onEviction?: (reason: StoreEvictionReason, count?: number) => void;
}): SessionStore {
  const maxEntries = options?.maxEntries ?? DEFAULT_SESSION_STORE_MAX_ENTRIES;
  const onEviction = options?.onEviction;
  const map = new Map<string, SessionRecord>();
  const cleanupExpired = () => {
    const now = Date.now();
    let removed = 0;
    for (const [id, record] of map.entries()) {
      if (record.expiresAt && now > Date.parse(record.expiresAt)) {
        map.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      onEviction?.('expired', removed);
    }
  };
  return {
    get: (id) => {
      const record = map.get(id);
      if (!record) return undefined;
      if (record.expiresAt && Date.now() > Date.parse(record.expiresAt)) {
        map.delete(id);
        onEviction?.('expired', 1);
        return undefined;
      }
      return record;
    },
    set: (id, value) => {
      cleanupExpired();
      if (!map.has(id) && map.size >= maxEntries) {
        return false;
      }
      map.set(id, value);
      return true;
    },
    delete: (id) => {
      map.delete(id);
    },
  };
}

export function createInMemoryNonceStore(options?: {
  maxEntries?: number;
  onEviction?: (reason: StoreEvictionReason, count?: number) => void;
}): NonceStore {
  const maxEntries = options?.maxEntries ?? DEFAULT_NONCE_STORE_MAX_ENTRIES;
  const onEviction = options?.onEviction;
  const nonces = new Map<string, number>();
  const cleanupExpired = () => {
    const now = Date.now();
    let removed = 0;
    for (const [key, exp] of nonces.entries()) {
      if (exp <= now) {
        nonces.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      onEviction?.('expired', removed);
    }
  };
  return {
    consume(nonce, expiresAtMs) {
      cleanupExpired();
      const now = Date.now();
      const existing = nonces.get(nonce);
      if (existing && existing > now) {
        return 'reused';
      }
      if (!existing && nonces.size >= maxEntries) {
        return 'saturated';
      }
      nonces.set(nonce, expiresAtMs);
      return 'consumed';
    },
  };
}

export function createGatewayServer(config: GatewayConfig) {
  if (!config.rpcUrl) throw new Error('rpcUrl is required');
  const allowInsecureSiweEnv = config.allowInsecureSiweEnv === true;
  const expectedDomain =
    typeof config.expectedDomain === 'string' && config.expectedDomain.trim().length > 0
      ? config.expectedDomain.trim()
      : undefined;
  const expectedChainId =
    typeof config.expectedChainId === 'number' && Number.isFinite(config.expectedChainId)
      ? config.expectedChainId
      : undefined;
  if (!allowInsecureSiweEnv && (!expectedDomain || expectedChainId === undefined)) {
    throw new Error(
      'Strict SIWE environment requires expectedDomain and expectedChainId (set LP_DOMAIN and LP_CHAIN_ID, or set allowInsecureSiweEnv for local development only)',
    );
  }
  const metrics = createGatewayMetricsRegistry();
  const store =
    config.sessionStore ??
    createInMemorySessionStore({
      maxEntries: config.sessionStoreMaxEntries ?? DEFAULT_SESSION_STORE_MAX_ENTRIES,
      onEviction: (reason, count) => metrics.incrementStoreEviction('session', reason, count),
    });
  const nonceStore =
    config.nonceStore ??
    createInMemoryNonceStore({
      maxEntries: config.nonceStoreMaxEntries ?? DEFAULT_NONCE_STORE_MAX_ENTRIES,
      onEviction: (reason, count) => metrics.incrementStoreEviction('nonce', reason, count),
    });
  const bodyLimit = config.bodyLimit ?? '512kb';
  const skewMs = config.maxClockSkewMs ?? DEFAULT_SKEW_MS;
  const siweSkewMs = config.maxSiweClockSkewMs ?? DEFAULT_SIWE_SKEW_MS;
  const minSessionTtlMs = config.minSessionTtlMs ?? DEFAULT_SESSION_TTL_MIN_MS;
  const maxSessionTtlMs = config.maxSessionTtlMs ?? DEFAULT_SESSION_TTL_MAX_MS;
  const nonceTtlMs = config.nonceTtlMs ?? maxSessionTtlMs;
  const requireTopicBinding = config.requireTopicBinding ?? true;
  const maxMessagePayloadBytes = config.maxMessagePayloadBytes ?? DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES;
  const rateLimiter = createRateLimiter({
    maxEvents: config.rateLimit ?? DEFAULT_RATE_LIMIT,
    windowMs: config.rateLimitWindowMs ?? DEFAULT_RATE_WINDOW_MS,
    maxEntries: config.rateLimitMaxEntries ?? DEFAULT_RATE_LIMITER_MAX_ENTRIES,
    onEviction: (reason, count) => metrics.incrementStoreEviction('rate_limiter', reason, count),
  });
  const deduper = createMessageDeduper(config.messageIdTtlMs ?? DEFAULT_MESSAGE_TTL_MS, {
    maxEntries: config.messageDeduperMaxEntries ?? DEFAULT_MESSAGE_DEDUPER_MAX_ENTRIES,
    onEviction: (reason, count) => metrics.incrementStoreEviction('message_dedupe', reason, count),
  });
  const balanceChecker = createBalanceChecker({
    minBalanceWei: config.minBalanceWei,
    cacheTtlMs: config.balanceCacheTtlMs ?? DEFAULT_BALANCE_CACHE_MS,
    maxEntries: config.balanceCacheMaxEntries ?? DEFAULT_BALANCE_CACHE_MAX_ENTRIES,
    provider:
      config.balanceProvider ??
      (config.minBalanceWei
        ? createRpcBalanceProvider(config.balanceRpcUrl ?? config.rpcUrl)
        : undefined),
    allowlist: config.allowlist,
    denylist: config.denylist,
    onEviction: (reason, count) => metrics.incrementStoreEviction('balance_cache', reason, count),
  });
  const publishToWaku = createMessagePublisher(config);
  const defaultPublishTransport: PublishTransport =
    config.publishTransport === 'rpc' ? 'rpc' : config.lightpushPeerId ? 'lightpush' : 'rpc';
  const app = express();
  app.use(express.json({ limit: bodyLimit }));

  const rejectWithTelemetry = (params: {
    res: Response;
    endpoint: GatewayEndpoint;
    status: number;
    reason: RejectReason;
    error: string;
    extra?: Record<string, unknown>;
  }) => {
    metrics.incrementReject(params.endpoint, params.reason);
    const saturatedStore = inferSaturatedStore(params.reason);
    if (saturatedStore) {
      metrics.incrementStoreSaturation(saturatedStore, params.endpoint);
    }
    console.warn(
      JSON.stringify({
        event: 'gateway.reject',
        endpoint: params.endpoint,
        status: params.status,
        reason: params.reason,
        error: params.error,
        ...params.extra,
      }),
    );
    return params.res.status(params.status).json({ error: params.error, ...(params.extra ?? {}) });
  };

  const logPublishOutcome = (params: {
    outcome: 'success' | 'failure';
    transport: PublishTransport;
    latencyMs: number;
    detail?: string;
  }) => {
    metrics.incrementPublish(params.outcome);
    const event = {
      event: 'gateway.publish',
      endpoint: '/message',
      outcome: params.outcome,
      transport: params.transport,
      latencyMs: params.latencyMs,
      detail: params.detail,
    };
    const serialized = JSON.stringify(event);
    if (params.outcome === 'success') {
      console.info(serialized);
      return;
    }
    console.error(serialized);
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/metrics', (_req, res) => {
    res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.toPrometheusText());
  });

  app.post('/session', (req: Request, res: Response) => {
    try {
      const { siweMessage, siweSignature, allowedTopics, allowedPubsubTopics } = req.body || {};
      if (!siweMessage || !siweSignature) {
        return rejectWithTelemetry({
          res,
          endpoint: '/session',
          status: 400,
          reason: REJECT_REASON.MISSING_SIWE_FIELDS,
          error: 'Missing siweMessage or siweSignature',
        });
      }
      const auth = verifySiweAuthorization({ siweMessage, siweSignature });
      const { siwe } = auth;
      if (expectedDomain && siwe.domain.toLowerCase() !== expectedDomain.toLowerCase()) {
        return rejectWithTelemetry({
          res,
          endpoint: '/session',
          status: 400,
          reason: REJECT_REASON.SIWE_DOMAIN_MISMATCH,
          error: 'SIWE domain mismatch',
        });
      }
      if (expectedChainId !== undefined && siwe.chainId !== expectedChainId) {
        return rejectWithTelemetry({
          res,
          endpoint: '/session',
          status: 400,
          reason: REJECT_REASON.SIWE_CHAIN_ID_MISMATCH,
          error: 'SIWE chainId mismatch',
        });
      }
      const issuedAtMs = parseSiweTime(siwe.issuedAt, 'issuedAt');
      const expirationMs = parseSiweTime(siwe.expirationTime, 'expirationTime');
      const now = Date.now();
      if (issuedAtMs > now + siweSkewMs) {
        return rejectWithTelemetry({
          res,
          endpoint: '/session',
          status: 400,
          reason: REJECT_REASON.SIWE_ISSUED_IN_FUTURE,
          error: 'SIWE issuedAt is in the future',
        });
      }
      if (expirationMs < now - siweSkewMs) {
        return rejectWithTelemetry({
          res,
          endpoint: '/session',
          status: 400,
          reason: REJECT_REASON.SIWE_EXPIRED,
          error: 'SIWE message expired',
        });
      }
      const ttlMs = expirationMs - issuedAtMs;
      if (ttlMs < minSessionTtlMs || ttlMs > maxSessionTtlMs) {
        return rejectWithTelemetry({
          res,
          endpoint: '/session',
          status: 400,
          reason: REJECT_REASON.SIWE_TTL_OUT_OF_BOUNDS,
          error: 'SIWE session TTL outside allowed bounds',
        });
      }
      if (!siwe.nonce) {
        return rejectWithTelemetry({
          res,
          endpoint: '/session',
          status: 400,
          reason: REJECT_REASON.SIWE_NONCE_MISSING,
          error: 'SIWE nonce missing',
        });
      }
      const nonceExpiryMs = Math.min(expirationMs, issuedAtMs + nonceTtlMs);
      if (now > nonceExpiryMs) {
        return rejectWithTelemetry({
          res,
          endpoint: '/session',
          status: 400,
          reason: REJECT_REASON.SIWE_NONCE_EXPIRED,
          error: 'SIWE nonce expired',
        });
      }
      const nonceConsumeResult = nonceStore.consume(siwe.nonce, nonceExpiryMs);
      if (nonceConsumeResult === 'saturated') {
        return rejectWithTelemetry({
          res,
          endpoint: '/session',
          status: 503,
          reason: REJECT_REASON.NONCE_STORE_SATURATED,
          error: 'Nonce admission store saturated',
        });
      }
      if (nonceConsumeResult === 'reused') {
        return rejectWithTelemetry({
          res,
          endpoint: '/session',
          status: 409,
          reason: REJECT_REASON.SIWE_NONCE_REUSED,
          error: 'SIWE nonce already used',
        });
      }
      const bindings = extractTopicBindings(siwe);
      const requestedTopics = normalizeTopics(allowedTopics);
      const requestedPubsubTopics = normalizeTopics(allowedPubsubTopics);
      const boundTopics = bindings.contentTopics;
      const boundPubsubTopics = bindings.pubsubTopics;
      const finalTopics = resolveBoundTopics({
        boundTopics,
        requestedTopics,
        configuredTopics: config.allowedTopics,
        requireBinding: requireTopicBinding,
        label: 'contentTopic',
      });
      const finalPubsubTopics = resolveBoundTopics({
        boundTopics: boundPubsubTopics,
        requestedTopics: requestedPubsubTopics,
        configuredTopics: config.allowedPubsubTopics,
        requireBinding: requireTopicBinding,
        label: 'pubsubTopic',
      });
      const record: SessionRecord = {
        address: auth.address,
        sessionPubKeyHex: auth.sessionPubKeyHex,
        allowedTopics: finalTopics,
        allowedPubsubTopics: finalPubsubTopics,
        issuedAt: siwe.issuedAt,
        expiresAt: new Date(expirationMs).toISOString(),
      };
      const sessionId = deriveSessionId({ siweMessage, siweSignature });
      if (!store.set(sessionId, record)) {
        return rejectWithTelemetry({
          res,
          endpoint: '/session',
          status: 503,
          reason: REJECT_REASON.SESSION_STORE_SATURATED,
          error: 'Session admission store saturated',
        });
      }
      res.json({ sessionId, address: auth.address, sessionPubKey: auth.sessionPubKeyHex, expiresAt: record.expiresAt });
    } catch (err) {
      const error = getErrorMessage(err);
      return rejectWithTelemetry({
        res,
        endpoint: '/session',
        status: 400,
        reason: inferSessionValidationReason(error),
        error,
      });
    }
  });

  app.post('/message', async (req: Request, res: Response) => {
    try {
      const { sessionId, contentTopic, pubsubTopic, payloadBase64 } = req.body || {};
      if (!sessionId || !contentTopic || !pubsubTopic || !payloadBase64) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 400,
          reason: REJECT_REASON.MISSING_REQUIRED_FIELDS,
          error: 'Missing required fields',
        });
      }
      let payloadBytes = 0;
      try {
        payloadBytes = estimateBase64DecodedByteLength(payloadBase64);
      } catch (error) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 400,
          reason: REJECT_REASON.INVALID_PAYLOAD,
          error: getErrorMessage(error),
        });
      }
      if (payloadBytes > maxMessagePayloadBytes) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 413,
          reason: REJECT_REASON.PAYLOAD_TOO_LARGE,
          error: 'Payload too large',
          extra: {
            payloadBytes,
            maxMessagePayloadBytes,
          },
        });
      }
      const record = store.get(sessionId);
      if (!record) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 401,
          reason: REJECT_REASON.UNKNOWN_SESSION,
          error: 'Unknown sessionId',
        });
      }
      if (isExpired(record.expiresAt)) {
        store.delete(sessionId);
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 401,
          reason: REJECT_REASON.SESSION_EXPIRED,
          error: 'Session expired',
        });
      }
      if (!topicAllowed(contentTopic, record.allowedTopics ?? config.allowedTopics)) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 403,
          reason: REJECT_REASON.TOPIC_NOT_ALLOWED,
          error: 'Topic not allowed',
        });
      }
      if (!topicAllowed(pubsubTopic, record.allowedPubsubTopics ?? config.allowedPubsubTopics)) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 403,
          reason: REJECT_REASON.PUBSUB_TOPIC_NOT_ALLOWED,
          error: 'Pubsub topic not allowed',
        });
      }
      const metadata: EnvelopeMetadata = { contentTopic, pubsubTopic };
      const envelope = decodeEnvelopePayload(payloadBase64) as SignedEnvelope<unknown>;
      if (envelope.sessionPubKey.toLowerCase() !== record.sessionPubKeyHex.toLowerCase()) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 400,
          reason: REJECT_REASON.SESSION_KEY_MISMATCH,
          error: 'Session key mismatch',
        });
      }
      if (envelope.senderAddress.toLowerCase() !== record.address.toLowerCase()) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 400,
          reason: REJECT_REASON.SENDER_MISMATCH,
          error: 'Sender mismatch',
        });
      }
      if (!verifyEnvelope({ metadata, envelope })) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 400,
          reason: REJECT_REASON.INVALID_ENVELOPE_SIGNATURE,
          error: 'Invalid envelope signature',
        });
      }
      if (Math.abs(Date.now() - envelope.timestampMs) > skewMs) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 400,
          reason: REJECT_REASON.TIMESTAMP_OUT_OF_SKEW,
          error: 'Timestamp outside allowed skew',
        });
      }
      if (!deduper.mark(envelope.messageId)) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 409,
          reason: REJECT_REASON.DUPLICATE_MESSAGE_ID,
          error: 'Duplicate messageId',
        });
      }
      if (!rateLimiter.consume(record.address.toLowerCase())) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 429,
          reason: REJECT_REASON.RATE_LIMIT_EXCEEDED,
          error: 'Rate limit exceeded',
        });
      }
      const balanceOk = await balanceChecker.allow(record.address);
      if (!balanceOk) {
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 403,
          reason: REJECT_REASON.INSUFFICIENT_BALANCE,
          error: 'Insufficient balance',
        });
      }

      const publishStartedAt = Date.now();
      try {
        const publishResult = await publishToWaku({ payloadBase64, contentTopic, pubsubTopic });
        const latencyMs = Date.now() - publishStartedAt;
        logPublishOutcome({
          outcome: 'success',
          transport: inferPublishTransport(publishResult, defaultPublishTransport),
          latencyMs,
        });
        res.json({ ok: true, relay: publishResult });
      } catch (publishError) {
        const latencyMs = Date.now() - publishStartedAt;
        const detail = getErrorMessage(publishError);
        logPublishOutcome({
          outcome: 'failure',
          transport: defaultPublishTransport,
          latencyMs,
          detail,
        });
        return rejectWithTelemetry({
          res,
          endpoint: '/message',
          status: 502,
          reason: REJECT_REASON.PUBLISH_FAILED,
          error: 'RPC call failed',
          extra: { detail },
        });
      }
    } catch (err) {
      return rejectWithTelemetry({
        res,
        endpoint: '/message',
        status: 400,
        reason: REJECT_REASON.MESSAGE_VALIDATION_FAILED,
        error: getErrorMessage(err),
      });
    }
  });

  return app;
}

type PublishParams = {
  payloadBase64: string;
  contentTopic: string;
  pubsubTopic: string;
};

function createMessagePublisher(config: GatewayConfig) {
  const transport = config.publishTransport ?? 'auto';
  if (transport === 'rpc') {
    return createRpcPublisher(config.rpcUrl);
  }

  const peerId = config.lightpushPeerId;
  if (!peerId) {
    if (transport === 'lightpush') {
      throw new Error('lightpush transport requires lightpushPeerId (LP_WAKU_PEER_ID or PRIMARY_WAKU_PEER_ID)');
    }
    // Auto mode falls back to RPC when no LightPush peer is configured.
    return createRpcPublisher(config.rpcUrl);
  }

  const wsUrl = config.lightpushWsUrl ?? deriveLightpushWsUrl(config.rpcUrl);
  return createLightpushPublisher({
    peerId,
    wsUrl,
    connectTimeoutMs: config.lightpushConnectTimeoutMs,
    rpcFallback: transport === 'auto' ? createRpcPublisher(config.rpcUrl) : undefined,
  });
}

function createRpcPublisher(rpcUrl: string) {
  return async (params: PublishParams) => {
    // Keep JSON-RPC relay publish as a fallback path while we evaluate long-term
    // transport direction for this stack version.
    const rpcBody = {
      jsonrpc: '2.0',
      method: 'post_waku_v2_relay_v1_message',
      params: [
        params.pubsubTopic,
        {
          payload: params.payloadBase64,
          contentTopic: params.contentTopic,
          timestamp: BigInt(Date.now()) * BigInt(1_000_000),
        },
      ],
      id: Date.now(),
    };
    const rpcResponse = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpcBody, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    });
    if (!rpcResponse.ok) {
      const text = await rpcResponse.text();
      throw new Error(text || `status ${rpcResponse.status}`);
    }
    return rpcResponse.json().catch(() => null);
  };
}

function deriveLightpushWsUrl(rpcUrl: string) {
  const parsed = new URL(rpcUrl);
  const isSecure = parsed.protocol === 'https:';
  const wsProtocol = isSecure ? 'wss:' : 'ws:';
  return `${wsProtocol}//${parsed.hostname}:8000`;
}

function createLightpushPublisher(options: {
  peerId: string;
  wsUrl: string;
  connectTimeoutMs?: number;
  rpcFallback?: (params: PublishParams) => Promise<unknown>;
}) {
  type LightpushContext = {
    node: any;
    waitForRemotePeer: (node: unknown, protocols: unknown[], timeoutMs?: number) => Promise<unknown>;
    protocols: { LightPush: unknown };
    connectedPubsubTopics: Set<string>;
  };
  let contextPromise: Promise<LightpushContext> | undefined;
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;

  const getContext = () => {
    if (!contextPromise) {
      contextPromise = createLightpushContext(options);
    }
    return contextPromise;
  };

  return async (params: PublishParams) => {
    try {
      const context = await getContext();
      if (!context.connectedPubsubTopics.has(params.pubsubTopic)) {
        await context.waitForRemotePeer(context.node, [context.protocols.LightPush], connectTimeoutMs);
        context.connectedPubsubTopics.add(params.pubsubTopic);
      }
      const shard = parseShardFromPubsubTopic(params.pubsubTopic);
      const encoder = context.node.createEncoder({ contentTopic: params.contentTopic, shardId: shard });
      const payloadBytes = new Uint8Array(Buffer.from(params.payloadBase64, 'base64'));
      const pushResult = await context.node.lightPush.send(encoder, { payload: payloadBytes, timestamp: new Date() });
      if (!pushResult?.successes?.length) {
        const failure = (pushResult?.failures || [])[0];
        const failureReason = failure?.error || 'unknown_error';
        throw new Error(`LightPush failed: ${failureReason}`);
      }
      return { transport: 'lightpush', successCount: pushResult.successes.length };
    } catch (error) {
      const lightpushError = error instanceof Error ? error.message : String(error);
      if (!options.rpcFallback) {
        throw error;
      }
      console.warn(`[gateway] LightPush publish failed, falling back to RPC: ${lightpushError}`);
      try {
        const fallbackResult = await options.rpcFallback(params);
        return { transport: 'rpc-fallback', lightpushError, relay: fallbackResult };
      } catch (rpcError) {
        const rpcErrorMessage = rpcError instanceof Error ? rpcError.message : String(rpcError);
        throw new Error(`LightPush failed: ${lightpushError}; RPC fallback failed: ${rpcErrorMessage}`);
      }
    }
  };
}

async function createLightpushContext(options: { peerId: string; wsUrl: string }) {
  await ensureJsWakuRuntime();
  const wakuModule = await import('../../../lib/js-waku.min.js');
  const createLightNode = wakuModule.createLightNode as (options: unknown) => Promise<any>;
  const waitForRemotePeer = wakuModule.waitForRemotePeer as (
    node: unknown,
    protocols: unknown[],
    timeoutMs?: number,
  ) => Promise<unknown>;
  const Protocols = wakuModule.Protocols as { LightPush: unknown };
  if (!createLightNode || !waitForRemotePeer || !Protocols) {
    throw new Error('Unable to load js-waku lightpush module');
  }

  const remoteMa = buildRemoteMultiaddr({ wsUrl: options.wsUrl, peerId: options.peerId });
  const defaultPubsub = '/waku/2/rs/999/0';
  const node = await createLightNode({
    defaultBootstrap: false,
    bootstrapPeers: [remoteMa],
    pubsubTopics: [defaultPubsub],
    shardInfo: { clusterId: 999, shards: [0] },
    networkConfig: { clusterId: 999 },
    libp2p: { filterMultiaddrs: false, hideWebSocketInfo: true },
    lightPush: { peers: [remoteMa] },
  });
  await node.start();
  await waitForRemotePeer(node, [Protocols.LightPush], 15_000);

  return {
    node,
    waitForRemotePeer,
    protocols: Protocols,
    connectedPubsubTopics: new Set<string>([defaultPubsub]),
  };
}

async function ensureJsWakuRuntime() {
  if (typeof globalThis.crypto === 'undefined') {
    const { webcrypto } = await import('node:crypto');
    (globalThis as typeof globalThis & { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
  }
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: `node/${process.version}` },
      configurable: true,
    });
  }
  if (typeof globalThis.CustomEvent === 'undefined') {
    (globalThis as any).CustomEvent = class CustomEvent extends Event {
      detail: unknown;
      constructor(type: string, params: CustomEventInit = {}) {
        super(type, params);
        this.detail = params.detail ?? null;
      }
    };
  }
  if (typeof globalThis.WebSocket === 'undefined') {
    const wsModuleName = 'ws';
    const wsModule = (await import(wsModuleName)) as { WebSocket?: unknown; default?: unknown };
    (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket =
      (wsModule.WebSocket ?? wsModule.default) as typeof WebSocket;
  }
  if (typeof Promise.withResolvers !== 'function') {
    (Promise as typeof Promise & {
      withResolvers: <T>() => { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void };
    }).withResolvers = function withResolvers<T>() {
      let resolve!: (v: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
  }
}

export const __gatewayTestUtils = {
  ensureJsWakuRuntime,
};

function buildRemoteMultiaddr(params: { wsUrl: string; peerId: string }) {
  const parsed = new URL(params.wsUrl);
  const port = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80));
  const transport = parsed.protocol === 'wss:' ? 'wss' : 'ws';
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname);
  const hostSegment = isIpv4 ? `/ip4/${parsed.hostname}` : `/dns4/${parsed.hostname}`;
  return `${hostSegment}/tcp/${port}/${transport}/p2p/${params.peerId}`;
}

function parseShardFromPubsubTopic(pubsubTopic: string) {
  const match = pubsubTopic.match(/^\/waku\/2\/rs\/\d+\/(\d+)$/);
  if (!match) {
    return 0;
  }
  return Number(match[1]);
}

function createRateLimiter(options: {
  maxEvents: number;
  windowMs: number;
  maxEntries: number;
  onEviction?: (reason: StoreEvictionReason, count?: number) => void;
}) {
  const buckets = new Map<string, { windowStart: number; count: number }>();
  const cleanupExpired = (now: number) => {
    let removed = 0;
    for (const [key, entry] of buckets.entries()) {
      if (now - entry.windowStart >= options.windowMs) {
        buckets.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      options.onEviction?.('expired', removed);
    }
  };
  return {
    consume(key: string) {
      const now = Date.now();
      cleanupExpired(now);
      const entry = buckets.get(key);
      if (!entry || now - entry.windowStart >= options.windowMs) {
        if (!entry && buckets.size >= options.maxEntries) {
          const overflow = buckets.size - options.maxEntries + 1;
          for (let i = 0; i < overflow; i += 1) {
            const oldest = buckets.keys().next().value;
            if (!oldest) break;
            buckets.delete(oldest);
          }
          options.onEviction?.('capacity', overflow);
        }
        buckets.set(key, { windowStart: now, count: 1 });
        return true;
      }
      if (entry.count >= options.maxEvents) {
        return false;
      }
      entry.count += 1;
      buckets.delete(key);
      buckets.set(key, entry);
      return true;
    },
  };
}

function createMessageDeduper(
  ttlMs: number,
  options: {
    maxEntries: number;
    onEviction?: (reason: StoreEvictionReason, count?: number) => void;
  },
) {
  const seen = new Map<string, number>();
  const cleanupExpired = (now: number) => {
    let removed = 0;
    for (const [id, ts] of seen.entries()) {
      if (now - ts >= ttlMs) {
        seen.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      options.onEviction?.('expired', removed);
    }
  };
  return {
    mark(messageId: string) {
      const now = Date.now();
      cleanupExpired(now);
      const existing = seen.get(messageId);
      if (existing && now - existing < ttlMs) {
        return false;
      }
      if (!existing && seen.size >= options.maxEntries) {
        const overflow = seen.size - options.maxEntries + 1;
        for (let i = 0; i < overflow; i += 1) {
          const oldest = seen.keys().next().value;
          if (!oldest) break;
          seen.delete(oldest);
        }
        options.onEviction?.('capacity', overflow);
      }
      seen.set(messageId, now);
      return true;
    },
  };
}

function createBalanceChecker(options: {
  minBalanceWei?: string | number | bigint;
  cacheTtlMs?: number;
  maxEntries?: number;
  provider?: (address: string) => Promise<bigint>;
  allowlist?: string[];
  denylist?: string[];
  onEviction?: (reason: StoreEvictionReason, count?: number) => void;
}) {
  if (!options.minBalanceWei) {
    return { allow: async () => true };
  }
  const minBalance = BigInt(options.minBalanceWei);
  const cacheTtl = options.cacheTtlMs ?? DEFAULT_BALANCE_CACHE_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_BALANCE_CACHE_MAX_ENTRIES;
  const provider = options.provider;
  if (!provider) {
    throw new Error('Balance provider required when minBalanceWei is set');
  }
  const cache = new Map<string, { value: bigint; fetchedAt: number }>();
  const allowSet = new Set((options.allowlist ?? []).map((a) => a.toLowerCase()));
  const denySet = new Set((options.denylist ?? []).map((a) => a.toLowerCase()));
  const cleanupExpired = (now: number) => {
    let removed = 0;
    for (const [key, entry] of cache.entries()) {
      if (now - entry.fetchedAt >= cacheTtl) {
        cache.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      options.onEviction?.('expired', removed);
    }
  };
  return {
    async allow(address: string) {
      const normalized = address.toLowerCase();
      if (denySet.has(normalized)) return false;
      if (allowSet.has(normalized)) return true;
      const now = Date.now();
      cleanupExpired(now);
      const cached = cache.get(normalized);
      if (cached && now - cached.fetchedAt < cacheTtl) {
        cache.delete(normalized);
        cache.set(normalized, cached);
        return cached.value >= minBalance;
      }
      if (!cached && cache.size >= maxEntries) {
        const overflow = cache.size - maxEntries + 1;
        for (let i = 0; i < overflow; i += 1) {
          const oldest = cache.keys().next().value;
          if (!oldest) break;
          cache.delete(oldest);
        }
        options.onEviction?.('capacity', overflow);
      }
      const value = await provider(normalized);
      cache.set(normalized, { value, fetchedAt: now });
      return value >= minBalance;
    },
  };
}

function createRpcBalanceProvider(rpcUrl: string) {
  return async (address: string): Promise<bigint> => {
    const body = {
      jsonrpc: '2.0',
      method: 'eth_getBalance',
      params: [address, 'latest'],
      id: Date.now(),
    };
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Balance RPC failed with status ${response.status}`);
    }
    const data = await response.json();
    if (data.error) {
      throw new Error(`Balance RPC error: ${data.error.message || 'unknown'}`);
    }
    if (typeof data.result !== 'string') {
      throw new Error('Balance RPC returned invalid result');
    }
    return BigInt(data.result);
  };
}

function topicAllowed(contentTopic: string, allowed?: string[]) {
  if (!allowed || allowed.length === 0) return true;
  return allowed.some((pattern) => {
    if (pattern.endsWith('*')) {
      return contentTopic.startsWith(pattern.slice(0, -1));
    }
    return pattern === contentTopic;
  });
}

function parseSiweTime(value: string | undefined, label: string) {
  if (!value) {
    throw new Error(`SIWE ${label} missing`);
  }
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    throw new Error(`SIWE ${label} invalid`);
  }
  return ts;
}

function estimateBase64DecodedByteLength(payloadBase64: unknown) {
  if (typeof payloadBase64 !== 'string') {
    throw new Error('payloadBase64 must be a base64 string');
  }
  const normalized = payloadBase64.trim();
  if (normalized.length === 0) {
    return 0;
  }
  if (normalized.length % 4 !== 0) {
    throw new Error('Invalid payloadBase64 encoding');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error('Invalid payloadBase64 encoding');
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return (normalized.length / 4) * 3 - padding;
}

function normalizeTopics(input?: unknown) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((topic) => String(topic)).filter((topic) => topic.length > 0);
  }
  if (typeof input === 'string') {
    return [input].filter((topic) => topic.length > 0);
  }
  return [];
}

function resolveBoundTopics(params: {
  boundTopics: string[];
  requestedTopics: string[];
  configuredTopics?: string[];
  requireBinding: boolean;
  label: string;
}) {
  const { boundTopics, requestedTopics, configuredTopics, requireBinding, label } = params;
  const configured = configuredTopics ?? [];
  const requested = requestedTopics ?? [];
  if (requireBinding && boundTopics.length === 0) {
    throw new Error(`SIWE ${label} binding missing`);
  }
  if (requireBinding && requested.length > 0 && !requested.every((topic) => boundTopics.includes(topic))) {
    throw new Error(`SIWE ${label} does not include requested topic`);
  }
  if (requireBinding && configured.length > 0 && !configured.every((topic) => boundTopics.includes(topic))) {
    throw new Error(`SIWE ${label} does not include configured topic`);
  }
  if (requested.length > 0) return requested;
  if (configured.length > 0) return configured;
  return boundTopics.length > 0 ? boundTopics : undefined;
}

function isExpired(expiresAt?: string) {
  if (!expiresAt) return false;
  return Date.now() > Date.parse(expiresAt);
}
