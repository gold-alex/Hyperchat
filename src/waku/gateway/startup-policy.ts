export type GatewayDeploymentContext = 'local' | 'non-local';

export interface GatewayPolicyViolation {
  code:
    | 'SIWE_INSECURE_OVERRIDE_NONLOCAL'
    | 'MISSING_LP_DOMAIN'
    | 'MISSING_LP_CHAIN_ID';
  policy: 'local_only_insecure_siwe_override' | 'strict_siwe_env_requirements';
  message: string;
  remediation: string;
  details: Record<string, string | number | boolean | undefined>;
}

export interface GatewayPolicyEvaluation {
  ok: boolean;
  context: GatewayDeploymentContext;
  contextSource: 'LP_DEPLOYMENT_CONTEXT' | 'NODE_ENV' | 'CI' | 'default';
  violations: GatewayPolicyViolation[];
}

const LOCAL_CONTEXT_VALUES = new Set(['local', 'dev', 'development', 'test']);
const NON_LOCAL_CONTEXT_VALUES = new Set([
  'non-local',
  'nonlocal',
  'prod',
  'production',
  'staging',
]);

function parseBoolean(value?: string): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

export function classifyGatewayDeploymentContext(input: {
  deploymentContextRaw?: string;
  nodeEnvRaw?: string;
  ciRaw?: string;
}): {
  context: GatewayDeploymentContext;
  source: GatewayPolicyEvaluation['contextSource'];
} {
  const explicit = input.deploymentContextRaw?.trim().toLowerCase();
  if (explicit) {
    if (LOCAL_CONTEXT_VALUES.has(explicit)) {
      return { context: 'local', source: 'LP_DEPLOYMENT_CONTEXT' };
    }
    if (NON_LOCAL_CONTEXT_VALUES.has(explicit)) {
      return { context: 'non-local', source: 'LP_DEPLOYMENT_CONTEXT' };
    }
    // Conservative fallback when an explicit value is invalid.
    return { context: 'non-local', source: 'LP_DEPLOYMENT_CONTEXT' };
  }

  const ciValue = parseBoolean(input.ciRaw);
  if (ciValue === true) {
    return { context: 'non-local', source: 'CI' };
  }

  const nodeEnv = input.nodeEnvRaw?.trim().toLowerCase();
  if (nodeEnv) {
    if (LOCAL_CONTEXT_VALUES.has(nodeEnv)) {
      return { context: 'local', source: 'NODE_ENV' };
    }
    if (NON_LOCAL_CONTEXT_VALUES.has(nodeEnv)) {
      return { context: 'non-local', source: 'NODE_ENV' };
    }
    // Conservative fallback when NODE_ENV is unknown.
    return { context: 'non-local', source: 'NODE_ENV' };
  }

  // Conservative default when no explicit deployment signal exists.
  return { context: 'non-local', source: 'default' };
}

export function evaluateGatewaySiweStartupPolicy(input: {
  allowInsecureSiweEnv: boolean;
  expectedDomain?: string;
  expectedChainId?: number;
  deploymentContextRaw?: string;
  nodeEnvRaw?: string;
  ciRaw?: string;
}): GatewayPolicyEvaluation {
  const deployment = classifyGatewayDeploymentContext({
    deploymentContextRaw: input.deploymentContextRaw,
    nodeEnvRaw: input.nodeEnvRaw,
    ciRaw: input.ciRaw,
  });
  const violations: GatewayPolicyViolation[] = [];

  if (input.allowInsecureSiweEnv) {
    if (deployment.context !== 'local') {
      violations.push({
        code: 'SIWE_INSECURE_OVERRIDE_NONLOCAL',
        policy: 'local_only_insecure_siwe_override',
        message:
          'LP_ALLOW_INSECURE_SIWE_ENV=true is only allowed in local development contexts.',
        remediation:
          'Disable LP_ALLOW_INSECURE_SIWE_ENV or set LP_DEPLOYMENT_CONTEXT=local for local development only.',
        details: {
          deploymentContext: deployment.context,
          contextSource: deployment.source,
        },
      });
    }
    return {
      ok: violations.length === 0,
      context: deployment.context,
      contextSource: deployment.source,
      violations,
    };
  }

  if (!input.expectedDomain) {
    violations.push({
      code: 'MISSING_LP_DOMAIN',
      policy: 'strict_siwe_env_requirements',
      message: 'Missing required env var: LP_DOMAIN (or LP_EXPECTED_DOMAIN).',
      remediation:
        'Set LP_DOMAIN and LP_CHAIN_ID in secure mode, or use LP_ALLOW_INSECURE_SIWE_ENV=true for local development only.',
      details: {
        deploymentContext: deployment.context,
        contextSource: deployment.source,
      },
    });
  }

  if (input.expectedChainId === undefined || !Number.isFinite(input.expectedChainId)) {
    violations.push({
      code: 'MISSING_LP_CHAIN_ID',
      policy: 'strict_siwe_env_requirements',
      message: 'Missing required env var: LP_CHAIN_ID.',
      remediation:
        'Set LP_CHAIN_ID in secure mode, or use LP_ALLOW_INSECURE_SIWE_ENV=true for local development only.',
      details: {
        deploymentContext: deployment.context,
        contextSource: deployment.source,
      },
    });
  }

  return {
    ok: violations.length === 0,
    context: deployment.context,
    contextSource: deployment.source,
    violations,
  };
}
