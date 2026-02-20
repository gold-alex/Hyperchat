import { createGatewayServer } from '../src/waku/gateway/server';
import { evaluateGatewaySiweStartupPolicy } from '../src/waku/gateway/startup-policy';

function parseList(value?: string) {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function parseNumber(value?: string) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseBoolean(value?: string) {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function parseBigint(value?: string) {
  if (!value) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function parseTransport(value?: string) {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'rpc' || normalized === 'lightpush') {
    return normalized as 'auto' | 'rpc' | 'lightpush';
  }
  return undefined;
}

function requireEnv(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const port = parseNumber(process.env.LP_GATEWAY_PORT) ?? 8787;
const rpcUrl = requireEnv('LP_RPC_HTTP', process.env.LP_RPC_URL ?? process.env.LP_RPC);

const allowedTopics = parseList(process.env.LP_ALLOWED_TOPICS);
const allowedPubsubTopics = parseList(process.env.LP_ALLOWED_PUBSUB_TOPICS ?? process.env.LP_ALLOWED_PUBSUB);
const allowlist = parseList(process.env.LP_ALLOWLIST);
const denylist = parseList(process.env.LP_DENYLIST);

const maxClockSkewMs = parseNumber(process.env.LP_MAX_CLOCK_SKEW_MS ?? process.env.LP_TIME_SKEW_MS);
const maxSiweClockSkewMs = parseNumber(process.env.LP_MAX_SIWE_SKEW_MS ?? process.env.LP_TIME_SKEW_MS);
const allowInsecureSiweEnv = parseBoolean(process.env.LP_ALLOW_INSECURE_SIWE_ENV) === true;
const expectedDomain = process.env.LP_DOMAIN ?? process.env.LP_EXPECTED_DOMAIN;
const expectedChainId = parseNumber(process.env.LP_CHAIN_ID);
const deploymentContextRaw = process.env.LP_DEPLOYMENT_CONTEXT;
const nodeEnvRaw = process.env.NODE_ENV;
const ciRaw = process.env.CI;

const policy = evaluateGatewaySiweStartupPolicy({
  allowInsecureSiweEnv,
  expectedDomain,
  expectedChainId,
  deploymentContextRaw,
  nodeEnvRaw,
  ciRaw,
});

if (!policy.ok) {
  for (const violation of policy.violations) {
    console.error(
      JSON.stringify({
        event: 'gateway.startup_policy_violation',
        code: violation.code,
        policy: violation.policy,
        message: violation.message,
        remediation: violation.remediation,
        details: violation.details,
      }),
    );
  }
  process.exit(1);
}

if (allowInsecureSiweEnv) {
  console.warn(
    '[SECURITY] LP_ALLOW_INSECURE_SIWE_ENV=true: domain/chain SIWE enforcement may be relaxed. Use only for local development.',
  );
}

const config = {
  rpcUrl,
  balanceRpcUrl: process.env.LP_BALANCE_RPC_URL,
  publishTransport: parseTransport(process.env.LP_PUBLISH_TRANSPORT),
  lightpushPeerId: process.env.LP_WAKU_PEER_ID ?? process.env.PRIMARY_WAKU_PEER_ID,
  lightpushWsUrl: process.env.LP_WAKU_WS_URL,
  lightpushConnectTimeoutMs: parseNumber(process.env.LP_WAKU_CONNECT_TIMEOUT_MS),
  allowedTopics,
  allowedPubsubTopics,
  expectedDomain,
  expectedChainId,
  allowInsecureSiweEnv,
  maxClockSkewMs,
  maxSiweClockSkewMs,
  minSessionTtlMs: parseNumber(process.env.LP_SESSION_TTL_MIN_MS),
  maxSessionTtlMs: parseNumber(process.env.LP_SESSION_TTL_MAX_MS),
  nonceTtlMs: parseNumber(process.env.LP_NONCE_TTL_MS),
  sessionStoreMaxEntries: parseNumber(process.env.LP_SESSION_STORE_MAX_ENTRIES),
  nonceStoreMaxEntries: parseNumber(process.env.LP_NONCE_STORE_MAX_ENTRIES),
  bodyLimit: process.env.LP_BODY_LIMIT,
  maxMessagePayloadBytes: parseNumber(process.env.LP_MAX_MESSAGE_PAYLOAD_BYTES),
  rateLimit: parseNumber(process.env.LP_RATE_LIMIT),
  rateLimitWindowMs: parseNumber(process.env.LP_RATE_WINDOW),
  rateLimitMaxEntries: parseNumber(process.env.LP_RATE_LIMIT_MAX_ENTRIES),
  messageIdTtlMs: parseNumber(process.env.LP_MESSAGE_ID_TTL_MS),
  messageDeduperMaxEntries: parseNumber(process.env.LP_MESSAGE_DEDUPER_MAX_ENTRIES),
  minBalanceWei: parseBigint(process.env.LP_MIN_BALANCE_WEI),
  balanceCacheTtlMs: parseNumber(process.env.LP_BALANCE_CACHE_TTL_MS),
  balanceCacheMaxEntries: parseNumber(process.env.LP_BALANCE_CACHE_MAX_ENTRIES),
  allowlist,
  denylist,
  requireTopicBinding: parseBoolean(process.env.LP_REQUIRE_TOPIC_BINDING),
};

const app = createGatewayServer(config);

app.listen(port, () => {
  console.log('Lightpush gateway listening');
  console.log(`  port: ${port}`);
  console.log(`  rpcUrl: ${rpcUrl}`);
  if (config.expectedDomain) console.log(`  expectedDomain: ${config.expectedDomain}`);
  if (config.expectedChainId !== undefined) console.log(`  expectedChainId: ${config.expectedChainId}`);
  if (config.allowInsecureSiweEnv) console.log('  allowInsecureSiweEnv: true');
  console.log(`  deploymentContext: ${policy.context} (${policy.contextSource})`);
  if (config.publishTransport) console.log(`  publishTransport: ${config.publishTransport}`);
  if (config.lightpushWsUrl) console.log(`  lightpushWsUrl: ${config.lightpushWsUrl}`);
  if (config.lightpushPeerId) console.log(`  lightpushPeerId: ${config.lightpushPeerId}`);
  if (allowedTopics) console.log(`  allowedTopics: ${allowedTopics.join(', ')}`);
  if (allowedPubsubTopics) console.log(`  allowedPubsubTopics: ${allowedPubsubTopics.join(', ')}`);
  if (config.sessionStoreMaxEntries !== undefined) console.log(`  sessionStoreMaxEntries: ${config.sessionStoreMaxEntries}`);
  if (config.nonceStoreMaxEntries !== undefined) console.log(`  nonceStoreMaxEntries: ${config.nonceStoreMaxEntries}`);
  if (config.rateLimitMaxEntries !== undefined) console.log(`  rateLimitMaxEntries: ${config.rateLimitMaxEntries}`);
  if (config.messageDeduperMaxEntries !== undefined) console.log(`  messageDeduperMaxEntries: ${config.messageDeduperMaxEntries}`);
  if (config.balanceCacheMaxEntries !== undefined) console.log(`  balanceCacheMaxEntries: ${config.balanceCacheMaxEntries}`);
});
