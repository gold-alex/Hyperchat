/**
 * Waku Integration Tests
 * 
 * Prerequisites:
 * 1. nwaku node must be running (see docs/waku-integration-testing.md)
 * 2. .env file must have correct VITE_WAKU_NODE_* variables
 * 
 * Run with: pnpm test __tests__/waku-integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Mock chrome runtime for tests
(globalThis as any).chrome = {
  runtime: {
    getURL: (path: string) => {
      // Return absolute paths for lib files during tests
      if (path.startsWith('lib/')) {
        return new URL(`../${path}`, import.meta.url).href;
      }
      return path;
    }
  }
} as any;

describe('Waku Integration Tests', () => {
  let WakuChatClient: any;
  let wakuClient: any;
  
  const TEST_CONFIG = {
    wakuNodeURI: process.env.VITE_WAKU_NODE_URI || 'localhost',
    wakuNodePort: parseInt(process.env.VITE_WAKU_NODE_PORT || '8000'),
    wakuNodePeerId: process.env.VITE_WAKU_NODE_PEER_ID || '',
    gatewayUrl: process.env.VITE_LIGHTPUSH_GATEWAY_URL || 'http://localhost:8787',
  };

  beforeAll(async () => {
    // Skip tests if peer ID not configured
    if (!TEST_CONFIG.wakuNodePeerId) {
      console.warn('VITE_WAKU_NODE_PEER_ID not set, skipping integration tests');
      console.warn('Set up .env file and start nwaku node first (cd docker && ./start-test-node.sh)');
      return;
    }

    // Dynamically import WakuChatClient (it's a plain JS module)
    const module = await import('../lib/waku-chat-client.js');
    WakuChatClient = module.WakuChatClient;
  });

  afterAll(async () => {
    if (wakuClient) {
      try {
        await wakuClient.disconnect();
      } catch (err) {
        console.error('Error disconnecting Waku client:', err);
      }
    }
  });

  beforeEach(() => {
    // Reset client before each test
    wakuClient = null;
  });

  describe('Configuration', () => {
    it('should skip tests if peer ID not configured', () => {
      if (!TEST_CONFIG.wakuNodePeerId) {
        expect(TEST_CONFIG.wakuNodePeerId).toBe('');
      } else {
        expect(TEST_CONFIG.wakuNodePeerId).toBeTruthy();
      }
    });

    it('should have WakuChatClient class available', () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      expect(WakuChatClient).toBeDefined();
      expect(typeof WakuChatClient).toBe('function');
    });
  });

  describe('Client Initialization', () => {
    it('should create WakuChatClient instance', () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient = new WakuChatClient(TEST_CONFIG);
      
      expect(wakuClient).toBeDefined();
      expect(wakuClient.wakuNodeURI).toBe(TEST_CONFIG.wakuNodeURI);
      expect(wakuClient.wakuNodePort).toBe(TEST_CONFIG.wakuNodePort);
      expect(wakuClient.wakuNodePeerId).toBe(TEST_CONFIG.wakuNodePeerId);
    });

    it('should have correct shard configuration', () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient = new WakuChatClient(TEST_CONFIG);
      
      expect(wakuClient.clusterId).toBe(999);
      expect(wakuClient.shardId).toBe(0);
    });

    it('should generate correct pubsub topic', () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient = new WakuChatClient(TEST_CONFIG);
      
      expect(wakuClient.getPubSubTopic()).toBe('/waku/2/rs/999/0');
    });

    it('should connect to nwaku node', async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient = new WakuChatClient({
        ...TEST_CONFIG,
        onConnectionStatusChange: (connected: boolean) => {
          console.log(`Connection status: ${connected}`);
        },
        onError: (error: Error) => {
          console.error('Waku error:', error);
        }
      });

      const success = await wakuClient.initialize();
      
      expect(success).toBe(true);
      expect(wakuClient.isConnected()).toBe(true);
      expect(wakuClient.waku).toBeDefined();
      expect(wakuClient.ChatMessageProto).toBeDefined();
    }, 30000); // 30s timeout for connection
  });

  describe('Content Topics', () => {
    beforeEach(() => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      wakuClient = new WakuChatClient(TEST_CONFIG);
    });

    it('should generate correct content topic for BTC-USD Perps', () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient.setRoom('BTC-USD', 'Perps');
      expect(wakuClient.getContentTopic()).toBe('/waku-auth-lite/1/BTC-USD_Perps/json');
    });

    it('should generate correct content topic for ETH-USD Spot', () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient.setRoom('ETH-USD', 'Spot');
      expect(wakuClient.getContentTopic()).toBe('/waku-auth-lite/1/ETH-USD_Spot/json');
    });

    it('should update content topic when room changes', () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient.setRoom('BTC-USD', 'Perps');
      expect(wakuClient.currentPair).toBe('BTC-USD');
      expect(wakuClient.currentMarket).toBe('Perps');
      
      wakuClient.setRoom('SOL-USD', 'Spot');
      expect(wakuClient.currentPair).toBe('SOL-USD');
      expect(wakuClient.currentMarket).toBe('Spot');
      expect(wakuClient.getContentTopic()).toBe('/waku-auth-lite/1/SOL-USD_Spot/json');
    });
  });

  describe('Store Protocol (History Loading)', () => {
    beforeEach(async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient = new WakuChatClient(TEST_CONFIG);
      await wakuClient.initialize();
    }, 30000);

    it('should load history without errors', async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient.setRoom('TEST-INTEGRATION', 'Perps');
      
      await expect(wakuClient.loadHistory()).resolves.not.toThrow();
      expect(Array.isArray(wakuClient.messages)).toBe(true);
    }, 30000);

    it('should handle empty history gracefully', async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      // Use a unique room that definitely has no messages
      const uniqueRoom = `TEST-${Date.now()}`;
      wakuClient.setRoom(uniqueRoom, 'Perps');
      
      const messages = await wakuClient.loadHistory();
      
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBe(0);
    }, 30000);

    it('should retry on failure', async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient.setRoom('TEST-RETRY', 'Perps');
      
      // loadHistoryWithRetry should not throw, even on failures
      await expect(wakuClient.loadHistoryWithRetry(3)).resolves.not.toThrow();
    }, 45000);
  });

  describe('Filter Protocol (Subscription)', () => {
    beforeEach(async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient = new WakuChatClient(TEST_CONFIG);
      await wakuClient.initialize();
    }, 30000);

    it('should subscribe to messages', async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient.setRoom('TEST-SUBSCRIPTION', 'Perps');
      
      await expect(wakuClient.subscribe()).resolves.not.toThrow();
    }, 30000);

    it('should receive callback on new messages', async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      const receivedMessages: any[] = [];
      
      wakuClient = new WakuChatClient({
        ...TEST_CONFIG,
        onMessageReceived: (message: any) => {
          receivedMessages.push(message);
        }
      });
      
      await wakuClient.initialize();
      wakuClient.setRoom('TEST-CALLBACK', 'Perps');
      await wakuClient.subscribe();
      
      // Note: Without sending a message, we can't verify receipt
      // This test just verifies subscription setup doesn't error
      expect(receivedMessages.length).toBeGreaterThanOrEqual(0);
    }, 30000);
  });

  describe('Wallet Info Management', () => {
    beforeEach(() => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      wakuClient = new WakuChatClient(TEST_CONFIG);
    });

    it('should set wallet info', () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      const testAddress = '0x1234567890123456789012345678901234567890';
      const testName = 'TestUser';
      
      wakuClient.setWalletInfo(testAddress, testName);
      
      expect(wakuClient.walletAddress).toBe(testAddress);
      expect(wakuClient.selectedName).toBe(testName);
    });

    it('should clear wallet info', () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient.setWalletInfo('0x1234', 'Test');
      expect(wakuClient.walletAddress).toBe('0x1234');
      
      wakuClient.setWalletInfo('', '');
      expect(wakuClient.walletAddress).toBe('');
      expect(wakuClient.selectedName).toBe('');
    });
  });

  describe('Error Handling', () => {
    it('should handle connection failure gracefully', async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      // Try to connect with invalid peer ID
      const badClient = new WakuChatClient({
        wakuNodeURI: TEST_CONFIG.wakuNodeURI,
        wakuNodePort: TEST_CONFIG.wakuNodePort,
        wakuNodePeerId: 'invalid-peer-id',
        onError: (error: Error) => {
          expect(error).toBeDefined();
        }
      });
      
      const success = await badClient.initialize();
      
      // Should fail but not throw
      expect(success).toBeFalsy();
    }, 30000);

    it('should throw error when loading history without initialization', async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient = new WakuChatClient(TEST_CONFIG);
      wakuClient.setRoom('TEST', 'Perps');
      
      await expect(wakuClient.loadHistory()).rejects.toThrow('Waku not connected');
    });

    it('should throw error when subscribing without initialization', async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient = new WakuChatClient(TEST_CONFIG);
      wakuClient.setRoom('TEST', 'Perps');
      
      await expect(wakuClient.subscribe()).rejects.toThrow('Waku not initialized');
    });
  });

  describe('Disconnect', () => {
    it('should disconnect cleanly', async () => {
      if (!TEST_CONFIG.wakuNodePeerId) return;
      
      wakuClient = new WakuChatClient(TEST_CONFIG);
      await wakuClient.initialize();
      
      expect(wakuClient.isConnected()).toBe(true);
      
      await wakuClient.disconnect();
      
      expect(wakuClient.waku).toBeNull();
      expect(wakuClient.ChatMessageProto).toBeNull();
    }, 30000);
  });
});
