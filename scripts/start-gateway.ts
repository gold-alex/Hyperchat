import { createGatewayServer } from '../src/waku/gateway/server';

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

const config = {
  rpcUrl,
  balanceRpcUrl: process.env.LP_BALANCE_RPC_URL,
  publishTransport: parseTransport(process.env.LP_PUBLISH_TRANSPORT),
  lightpushPeerId: process.env.LP_WAKU_PEER_ID ?? process.env.PRIMARY_WAKU_PEER_ID,
  lightpushWsUrl: process.env.LP_WAKU_WS_URL,
  lightpushConnectTimeoutMs: parseNumber(process.env.LP_WAKU_CONNECT_TIMEOUT_MS),
  allowedTopics,
  allowedPubsubTopics,
  expectedDomain: process.env.LP_DOMAIN ?? process.env.LP_EXPECTED_DOMAIN,
  expectedChainId: parseNumber(process.env.LP_CHAIN_ID),
  maxClockSkewMs,
  maxSiweClockSkewMs,
  minSessionTtlMs: parseNumber(process.env.LP_SESSION_TTL_MIN_MS),
  maxSessionTtlMs: parseNumber(process.env.LP_SESSION_TTL_MAX_MS),
  nonceTtlMs: parseNumber(process.env.LP_NONCE_TTL_MS),
  bodyLimit: process.env.LP_BODY_LIMIT,
  maxMessagePayloadBytes: parseNumber(process.env.LP_MAX_MESSAGE_PAYLOAD_BYTES),
  rateLimit: parseNumber(process.env.LP_RATE_LIMIT),
  rateLimitWindowMs: parseNumber(process.env.LP_RATE_WINDOW),
  messageIdTtlMs: parseNumber(process.env.LP_MESSAGE_ID_TTL_MS),
  minBalanceWei: parseBigint(process.env.LP_MIN_BALANCE_WEI),
  balanceCacheTtlMs: parseNumber(process.env.LP_BALANCE_CACHE_TTL_MS),
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
  if (config.expectedChainId) console.log(`  expectedChainId: ${config.expectedChainId}`);
  if (config.publishTransport) console.log(`  publishTransport: ${config.publishTransport}`);
  if (config.lightpushWsUrl) console.log(`  lightpushWsUrl: ${config.lightpushWsUrl}`);
  if (config.lightpushPeerId) console.log(`  lightpushPeerId: ${config.lightpushPeerId}`);
  if (allowedTopics) console.log(`  allowedTopics: ${allowedTopics.join(', ')}`);
  if (allowedPubsubTopics) console.log(`  allowedPubsubTopics: ${allowedPubsubTopics.join(', ')}`);
});
