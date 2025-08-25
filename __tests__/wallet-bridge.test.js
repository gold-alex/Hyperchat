// Tests for wallet-bridge.js

describe('Wallet Bridge', () => {
  // Mock the message event handler
  let messageHandler;
  
  // Setup before each test
  beforeEach(() => {
    // Clear any previous mocks
    jest.clearAllMocks();
    
    // Reset window.ethereum
    window.ethereum = undefined;
    
    // Mock window.postMessage
    window.postMessage = jest.fn();
    
    // Mock window.addEventListener to capture the message event handler
    const originalAddEventListener = window.addEventListener;
    window.addEventListener = jest.fn((event, handler) => {
      if (event === 'message') {
        messageHandler = handler;
      }
    });
    
    // Load wallet-bridge.js to execute the IIFE
    jest.isolateModules(() => {
      require('../wallet-bridge.js');
    });
    
    // Restore original addEventListener
    window.addEventListener = originalAddEventListener;
  });

  describe('getProvider function', () => {
    test('should return null when window.ethereum is undefined', async () => {
      // window.ethereum is already undefined
      
      // Create a message event with a connect request
      const event = {
        source: window,
        data: {
          type: 'HL_CONNECT_WALLET_REQUEST',
          id: 'test-id'
        }
      };
      
      // Call the message handler
      await messageHandler(event);
      
      // Assert that postMessage was called with an error
      expect(window.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'HL_CONNECT_WALLET_RESPONSE',
          id: 'test-id',
          error: expect.stringContaining('No Ethereum wallet found')
        }),
        '*'
      );
    });
    
    test('should prefer Rabby over other providers', async () => {
      // Setup - mock window.ethereum with providers array
      window.ethereum = {
        providers: [
          { isMetaMask: true, request: jest.fn().mockResolvedValue(['0xmetamask']) },
          { isRabby: true, request: jest.fn().mockResolvedValue(['0xrabby']) },
          { request: jest.fn().mockResolvedValue(['0xother']) }
        ]
      };
      
      // Create a message event with a connect request
      const event = {
        source: window,
        data: {
          type: 'HL_CONNECT_WALLET_REQUEST',
          id: 'test-id'
        }
      };
      
      // Call the message handler
      await messageHandler(event);
      
      // Assert that Rabby's request method was called
      expect(window.ethereum.providers[1].request).toHaveBeenCalledWith({
        method: 'eth_requestAccounts'
      });
      
      // Assert that postMessage was called with Rabby's accounts
      expect(window.postMessage).toHaveBeenCalledWith(
        {
          type: 'HL_CONNECT_WALLET_RESPONSE',
          id: 'test-id',
          accounts: ['0xrabby']
        },
        '*'
      );
    });
    
    test('should prefer MetaMask if Rabby is not available', async () => {
      // Setup - mock window.ethereum with providers array without Rabby
      window.ethereum = {
        providers: [
          { request: jest.fn().mockResolvedValue(['0xother']) },
          { isMetaMask: true, request: jest.fn().mockResolvedValue(['0xmetamask']) }
        ]
      };
      
      // Create a message event with a connect request
      const event = {
        source: window,
        data: {
          type: 'HL_CONNECT_WALLET_REQUEST',
          id: 'test-id'
        }
      };
      
      // Call the message handler
      await messageHandler(event);
      
      // Assert that MetaMask's request method was called
      expect(window.ethereum.providers[1].request).toHaveBeenCalledWith({
        method: 'eth_requestAccounts'
      });
      
      // Assert that postMessage was called with MetaMask's accounts
      expect(window.postMessage).toHaveBeenCalledWith(
        {
          type: 'HL_CONNECT_WALLET_RESPONSE',
          id: 'test-id',
          accounts: ['0xmetamask']
        },
        '*'
      );
    });
    
    test('should use first provider if neither Rabby nor MetaMask are available', async () => {
      // Setup - mock window.ethereum with providers array without Rabby or MetaMask
      window.ethereum = {
        providers: [
          { request: jest.fn().mockResolvedValue(['0xfirst']) },
          { request: jest.fn().mockResolvedValue(['0xsecond']) }
        ]
      };
      
      // Create a message event with a connect request
      const event = {
        source: window,
        data: {
          type: 'HL_CONNECT_WALLET_REQUEST',
          id: 'test-id'
        }
      };
      
      // Call the message handler
      await messageHandler(event);
      
      // Assert that the first provider's request method was called
      expect(window.ethereum.providers[0].request).toHaveBeenCalledWith({
        method: 'eth_requestAccounts'
      });
      
      // Assert that postMessage was called with the first provider's accounts
      expect(window.postMessage).toHaveBeenCalledWith(
        {
          type: 'HL_CONNECT_WALLET_RESPONSE',
          id: 'test-id',
          accounts: ['0xfirst']
        },
        '*'
      );
    });
    
    test('should use window.ethereum directly if providers array is not available', async () => {
      // Setup - mock window.ethereum without providers array
      window.ethereum = {
        request: jest.fn().mockResolvedValue(['0xdirect'])
      };
      
      // Create a message event with a connect request
      const event = {
        source: window,
        data: {
          type: 'HL_CONNECT_WALLET_REQUEST',
          id: 'test-id'
        }
      };
      
      // Call the message handler
      await messageHandler(event);
      
      // Assert that window.ethereum's request method was called
      expect(window.ethereum.request).toHaveBeenCalledWith({
        method: 'eth_requestAccounts'
      });
      
      // Assert that postMessage was called with window.ethereum's accounts
      expect(window.postMessage).toHaveBeenCalledWith(
        {
          type: 'HL_CONNECT_WALLET_RESPONSE',
          id: 'test-id',
          accounts: ['0xdirect']
        },
        '*'
      );
    });
  });

  describe('Message event handlers', () => {
    test('should ignore messages not from window', async () => {
      // Setup - mock window.ethereum
      window.ethereum = {
        request: jest.fn()
      };
      
      // Create a message event with source not equal to window
      const event = {
        source: {}, // Not window
        data: {
          type: 'HL_CONNECT_WALLET_REQUEST',
          id: 'test-id'
        }
      };
      
      // Call the message handler
      await messageHandler(event);
      
      // Assert that window.ethereum.request was not called
      expect(window.ethereum.request).not.toHaveBeenCalled();
      
      // Assert that window.postMessage was not called
      expect(window.postMessage).not.toHaveBeenCalled();
    });
    
    test('should ignore messages without data', async () => {
      // Setup - mock window.ethereum
      window.ethereum = {
        request: jest.fn()
      };
      
      // Create a message event without data
      const event = {
        source: window,
        data: null
      };
      
      // Call the message handler
      await messageHandler(event);
      
      // Assert that window.ethereum.request was not called
      expect(window.ethereum.request).not.toHaveBeenCalled();
      
      // Assert that window.postMessage was not called
      expect(window.postMessage).not.toHaveBeenCalled();
    });
    
    test('should ignore messages with unrelated type', async () => {
      // Setup - mock window.ethereum
      window.ethereum = {
        request: jest.fn()
      };
      
      // Create a message event with unrelated type
      const event = {
        source: window,
        data: {
          type: 'UNRELATED_TYPE',
          id: 'test-id'
        }
      };
      
      // Call the message handler
      await messageHandler(event);
      
      // Assert that window.ethereum.request was not called
      expect(window.ethereum.request).not.toHaveBeenCalled();
      
      // Assert that window.postMessage was not called
      expect(window.postMessage).not.toHaveBeenCalled();
    });
    
    test('should handle HL_SIGN_REQUEST and call personal_sign', async () => {
      // Setup - mock window.ethereum
      window.ethereum = {
        request: jest.fn().mockResolvedValue('0xsignature')
      };
      
      // Create a sign request event
      const event = {
        source: window,
        data: {
          type: 'HL_SIGN_REQUEST',
          id: 'sign-id',
          message: 'Hello, world!',
          address: '0xuser'
        }
      };
      
      // Call the message handler
      await messageHandler(event);
      
      // Assert that window.ethereum.request was called with correct parameters
      expect(window.ethereum.request).toHaveBeenCalledWith({
        method: 'personal_sign',
        params: ['Hello, world!', '0xuser']
      });
      
      // Assert that window.postMessage was called with the signature
      expect(window.postMessage).toHaveBeenCalledWith(
        {
          type: 'HL_SIGN_RESPONSE',
          id: 'sign-id',
          signature: '0xsignature'
        },
        '*'
      );
    });
    
    test('should handle errors during signing', async () => {
      // Setup - mock window.ethereum with request that rejects
      window.ethereum = {
        request: jest.fn().mockRejectedValue(new Error('User rejected signature'))
      };
      
      // Create a sign request event
      const event = {
        source: window,
        data: {
          type: 'HL_SIGN_REQUEST',
          id: 'sign-id',
          message: 'Hello, world!',
          address: '0xuser'
        }
      };
      
      // Call the message handler
      await messageHandler(event);
      
      // Assert that window.postMessage was called with the error
      expect(window.postMessage).toHaveBeenCalledWith(
        {
          type: 'HL_SIGN_RESPONSE',
          id: 'sign-id',
          error: 'User rejected signature'
        },
        '*'
      );
    });
  });
});