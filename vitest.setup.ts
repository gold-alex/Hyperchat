import { TextEncoder, TextDecoder } from 'node:util';
import { fakeBrowser } from 'wxt/testing';
import { vi } from 'vitest';

// Polyfills similar to Jest setup
// @ts-ignore
global.TextEncoder = TextEncoder as any;
// @ts-ignore
global.TextDecoder = TextDecoder as any;

// Provide a fake browser/chrome API for unit tests
// Matches WXT guidance: https://wxt.dev/guide/essentials/unit-testing.html
// fakeBrowser implements both browser and chrome APIs
// @ts-ignore
global.chrome = fakeBrowser as any;
// @ts-ignore
global.browser = fakeBrowser as any;

// Basic fetch mock; override in tests as needed
// @ts-ignore
if (!global.fetch) {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  // @ts-ignore
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
}

// Provide Jest compatibility shims so existing tests run under Vitest
// @ts-ignore
global.jest = vi as any;

// Mock 'module' import interface used by some tests to simulate dynamic imports
vi.mock('module', () => ({
  import: vi.fn().mockImplementation((path: string) => Promise.reject(new Error(`Module not mocked: ${path}`))),
}));

// Make fakeBrowser methods mockable where tests expect jest.fn semantics
const chromeAny: any = (global as any).chrome as any;
chromeAny.runtime = chromeAny.runtime || {};
chromeAny.runtime.getURL = vi.fn((p: string) => p);
chromeAny.runtime.sendMessage = vi.fn();
chromeAny.runtime.onInstalled = chromeAny.runtime.onInstalled || { addListener: vi.fn() };

chromeAny.storage = chromeAny.storage || {};
chromeAny.storage.local = chromeAny.storage.local || {};
chromeAny.storage.local.get = vi.fn();
chromeAny.storage.local.set = vi.fn();

chromeAny.tabs = chromeAny.tabs || {};
chromeAny.tabs.query = vi.fn();
chromeAny.tabs.sendMessage = vi.fn();
chromeAny.tabs.create = vi.fn();
chromeAny.tabs.onUpdated = chromeAny.tabs.onUpdated || { addListener: vi.fn(), removeListener: vi.fn() };

chromeAny.sidePanel = chromeAny.sidePanel || { setOptions: vi.fn(), open: vi.fn(), setPanelBehavior: vi.fn() };
chromeAny.contextMenus = chromeAny.contextMenus || { update: vi.fn(), create: vi.fn(), onClicked: { addListener: vi.fn() } };

// Allow tests to disable wallet bridge injection
// @ts-ignore
(global as any).DISABLE_WALLET_BRIDGE = true;
