import { describe, expect, it } from 'vitest';

import {
  classifyGatewayDeploymentContext,
  evaluateGatewaySiweStartupPolicy,
} from '../src/waku/gateway/startup-policy';

describe('gateway startup SIWE policy', () => {
  it('classifies explicit LP_DEPLOYMENT_CONTEXT=local as local', () => {
    const result = classifyGatewayDeploymentContext({
      deploymentContextRaw: 'local',
    });
    expect(result).toEqual({
      context: 'local',
      source: 'LP_DEPLOYMENT_CONTEXT',
    });
  });

  it('defaults to non-local when deployment context is missing', () => {
    const result = classifyGatewayDeploymentContext({});
    expect(result).toEqual({
      context: 'non-local',
      source: 'default',
    });
  });

  it('allows insecure override in local context', () => {
    const result = evaluateGatewaySiweStartupPolicy({
      allowInsecureSiweEnv: true,
      deploymentContextRaw: 'local',
    });
    expect(result.ok).toBe(true);
    expect(result.context).toBe('local');
    expect(result.violations).toHaveLength(0);
  });

  it('rejects insecure override in non-local context', () => {
    const result = evaluateGatewaySiweStartupPolicy({
      allowInsecureSiweEnv: true,
      deploymentContextRaw: 'production',
    });
    expect(result.ok).toBe(false);
    expect(result.context).toBe('non-local');
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SIWE_INSECURE_OVERRIDE_NONLOCAL',
          policy: 'local_only_insecure_siwe_override',
        }),
      ]),
    );
  });

  it('requires LP_DOMAIN and LP_CHAIN_ID in strict mode', () => {
    const result = evaluateGatewaySiweStartupPolicy({
      allowInsecureSiweEnv: false,
      expectedDomain: '',
      expectedChainId: undefined,
      deploymentContextRaw: 'production',
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code).sort()).toEqual([
      'MISSING_LP_CHAIN_ID',
      'MISSING_LP_DOMAIN',
    ]);
  });

  it('passes strict mode when domain and chain are set', () => {
    const result = evaluateGatewaySiweStartupPolicy({
      allowInsecureSiweEnv: false,
      expectedDomain: 'gateway.example',
      expectedChainId: 998,
      deploymentContextRaw: 'production',
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
