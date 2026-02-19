// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { getConfig } from '../scripts/gateway-session-message-smoke-test';

const originalEnv = {
  LP_SMOKE_GATEWAY_URL: process.env.LP_SMOKE_GATEWAY_URL,
  VITE_LIGHTPUSH_GATEWAY_URL: process.env.VITE_LIGHTPUSH_GATEWAY_URL,
  LP_SMOKE_DOMAIN: process.env.LP_SMOKE_DOMAIN,
  LP_DOMAIN: process.env.LP_DOMAIN,
  LP_SMOKE_CHAIN_ID: process.env.LP_SMOKE_CHAIN_ID,
  LP_CHAIN_ID: process.env.LP_CHAIN_ID,
};

afterEach(() => {
  process.env.LP_SMOKE_GATEWAY_URL = originalEnv.LP_SMOKE_GATEWAY_URL;
  process.env.VITE_LIGHTPUSH_GATEWAY_URL = originalEnv.VITE_LIGHTPUSH_GATEWAY_URL;
  process.env.LP_SMOKE_DOMAIN = originalEnv.LP_SMOKE_DOMAIN;
  process.env.LP_DOMAIN = originalEnv.LP_DOMAIN;
  process.env.LP_SMOKE_CHAIN_ID = originalEnv.LP_SMOKE_CHAIN_ID;
  process.env.LP_CHAIN_ID = originalEnv.LP_CHAIN_ID;
});

describe('gateway smoke config', () => {
  it('fails with explicit config error when gateway URL is missing', () => {
    delete process.env.LP_SMOKE_GATEWAY_URL;
    delete process.env.VITE_LIGHTPUSH_GATEWAY_URL;

    expect(() => getConfig()).toThrow(/Missing gateway URL/);
  });

  it('uses explicitly configured smoke gateway URL', () => {
    process.env.LP_SMOKE_GATEWAY_URL = 'http://localhost:8787/';
    delete process.env.VITE_LIGHTPUSH_GATEWAY_URL;
    delete process.env.LP_SMOKE_DOMAIN;
    delete process.env.LP_DOMAIN;
    delete process.env.LP_SMOKE_CHAIN_ID;
    delete process.env.LP_CHAIN_ID;

    const config = getConfig();

    expect(config.gatewayBaseUrl).toBe('http://localhost:8787');
    expect(config.domain).toBe('localhost');
    expect(config.chainId).toBe(1);
  });

  it('rejects insecure remote gateway URL', () => {
    process.env.LP_SMOKE_GATEWAY_URL = 'http://gateway.example.com';
    delete process.env.VITE_LIGHTPUSH_GATEWAY_URL;

    expect(() => getConfig()).toThrow(/Insecure non-local gateway URL is not allowed/);
  });

  it('accepts secure remote gateway URL', () => {
    process.env.LP_SMOKE_GATEWAY_URL = 'https://gateway.example.com';
    delete process.env.VITE_LIGHTPUSH_GATEWAY_URL;
    delete process.env.LP_SMOKE_DOMAIN;
    delete process.env.LP_DOMAIN;
    delete process.env.LP_SMOKE_CHAIN_ID;
    delete process.env.LP_CHAIN_ID;

    const config = getConfig();
    expect(config.gatewayBaseUrl).toBe('https://gateway.example.com');
    expect(config.domain).toBe('gateway.example.com');
  });
});
