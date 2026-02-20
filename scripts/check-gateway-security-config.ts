import { evaluateGatewaySiweStartupPolicy } from '../src/waku/gateway/startup-policy';

function parseBoolean(value?: string): boolean {
  if (!value) return false;
  return value.trim().toLowerCase() === 'true';
}

function parseNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const policy = evaluateGatewaySiweStartupPolicy({
  allowInsecureSiweEnv: parseBoolean(process.env.LP_ALLOW_INSECURE_SIWE_ENV),
  expectedDomain: process.env.LP_DOMAIN ?? process.env.LP_EXPECTED_DOMAIN,
  expectedChainId: parseNumber(process.env.LP_CHAIN_ID),
  deploymentContextRaw: process.env.LP_DEPLOYMENT_CONTEXT,
  nodeEnvRaw: process.env.NODE_ENV,
  ciRaw: process.env.CI,
});

if (!policy.ok) {
  for (const violation of policy.violations) {
    console.error(
      JSON.stringify({
        event: 'gateway.policy_check_failed',
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

console.log(
  JSON.stringify({
    event: 'gateway.policy_check_passed',
    deploymentContext: policy.context,
    contextSource: policy.contextSource,
  }),
);
