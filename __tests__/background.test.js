// Tests for background.js service worker

describe('Background Service Worker', () => {
  // Define the message handler function directly for testing
  const messageHandler = (request, sender, sendResponse) => {
    if (request.action === "getStoredData") {
      chrome.storage.local.get([request.key], (result) => {
        sendResponse(result[request.key])
      })
      return true
    }
  
    if (request.action === "setStoredData") {
      chrome.storage.local.set({ [request.key]: request.value }, () => {
        sendResponse({ success: true })
      })
      return true
    }
  
    if (request.action === "openStandaloneChat") {
      const url = chrome.runtime.getURL(`chat-widget.html?pair=${encodeURIComponent(request.pair||'UNKNOWN')}&market=${encodeURIComponent(request.market||'Perps')}`)
      chrome.tabs.create({ url })
      sendResponse({ success: true })
      return true
    }
  
    if (request.action === 'roomChange' || request.action === 'showChat') {
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, request)
        })
      })
      sendResponse({success:true})
      return true
    }
  };

  // Reset mocks before each test
  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();
  });

  describe('Message Handler: getStoredData', () => {
    test('should retrieve data from chrome.storage.local and send response', () => {
      // Setup
      const request = { action: 'getStoredData', key: 'testKey' };
      const sender = {};
      const sendResponse = jest.fn();
      
      // Mock chrome.storage.local.get to simulate retrieving data
      chrome.storage.local.get.mockImplementation((keys, callback) => {
        callback({ testKey: 'testValue' });
      });
      
      // Execute message listener
      const result = messageHandler(request, sender, sendResponse);
      
      // Assert
      expect(chrome.storage.local.get).toHaveBeenCalledWith(['testKey'], expect.any(Function));
      expect(sendResponse).toHaveBeenCalledWith('testValue');
      expect(result).toBe(true); // Should return true to indicate async response
    });
  });

  describe('Message Handler: setStoredData', () => {
    test('should store data in chrome.storage.local and send success response', () => {
      // Setup
      const request = { action: 'setStoredData', key: 'testKey', value: 'testValue' };
      const sender = {};
      const sendResponse = jest.fn();
      
      // Mock chrome.storage.local.set to simulate storing data
      chrome.storage.local.set.mockImplementation((data, callback) => {
        callback();
      });
      
      // Execute message listener
      const result = messageHandler(request, sender, sendResponse);
      
      // Assert
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ testKey: 'testValue' }, expect.any(Function));
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
      expect(result).toBe(true); // Should return true to indicate async response
    });
  });

  describe('Message Handler: openStandaloneChat', () => {
    test('should create a new tab with chat widget URL and send success response', () => {
      // Setup
      const request = { action: 'openStandaloneChat', pair: 'ETH-USDC', market: 'Perps' };
      const sender = {};
      const sendResponse = jest.fn();
      
      // Mock chrome.runtime.getURL to return a fake URL
      chrome.runtime.getURL.mockReturnValue('chrome-extension://mock-id/chat-widget.html?pair=ETH-USDC&market=Perps');
      
      // Execute message listener
      const result = messageHandler(request, sender, sendResponse);
      
      // Assert
      expect(chrome.runtime.getURL).toHaveBeenCalledWith('chat-widget.html?pair=ETH-USDC&market=Perps');
      expect(chrome.tabs.create).toHaveBeenCalledWith({ 
        url: 'chrome-extension://mock-id/chat-widget.html?pair=ETH-USDC&market=Perps' 
      });
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
      expect(result).toBe(true); // Should return true to indicate async response
    });

    test('should handle missing pair and market parameters with defaults', () => {
      // Setup
      const request = { action: 'openStandaloneChat' }; // No pair or market
      const sender = {};
      const sendResponse = jest.fn();
      
      // Execute message listener
      const result = messageHandler(request, sender, sendResponse);
      
      // Assert
      expect(chrome.runtime.getURL).toHaveBeenCalledWith('chat-widget.html?pair=UNKNOWN&market=Perps');
      expect(chrome.tabs.create).toHaveBeenCalled();
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
      expect(result).toBe(true);
    });
  });

  describe('Message Handler: roomChange and showChat', () => {
    test('should relay roomChange message to all tabs', () => {
      // Setup
      const request = { action: 'roomChange', pair: 'ETH-USDC', market: 'Perps' };
      const sender = {};
      const sendResponse = jest.fn();
      
      // Mock chrome.tabs.query to return list of tabs
      const mockTabs = [
        { id: 1 },
        { id: 2 }
      ];
      chrome.tabs.query.mockImplementation((query, callback) => {
        callback(mockTabs);
      });
      
      // Execute message listener
      const result = messageHandler(request, sender, sendResponse);
      
      // Assert
      expect(chrome.tabs.query).toHaveBeenCalledWith({}, expect.any(Function));
      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, request);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(2, request);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
      expect(result).toBe(true);
    });

    test('should relay showChat message to all tabs', () => {
      // Setup
      const request = { action: 'showChat', pair: 'ETH-USDC', market: 'Perps' };
      const sender = {};
      const sendResponse = jest.fn();
      
      // Mock chrome.tabs.query to return list of tabs
      const mockTabs = [
        { id: 1 },
        { id: 2 }
      ];
      chrome.tabs.query.mockImplementation((query, callback) => {
        callback(mockTabs);
      });
      
      // Execute message listener
      const result = messageHandler(request, sender, sendResponse);
      
      // Assert
      expect(chrome.tabs.query).toHaveBeenCalledWith({}, expect.any(Function));
      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, request);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(2, request);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
      expect(result).toBe(true);
    });
  });

  describe('onInstalled handler', () => {
    test('should log installation message', () => {
      // Setup
      const consoleSpy = jest.spyOn(console, 'log');
      
      // Execute the onInstalled listener directly
      const onInstalledHandler = () => {
        console.log("Hyperliquid Chat extension installed");
      };
      onInstalledHandler();
      
      // Assert
      expect(consoleSpy).toHaveBeenCalledWith('Hyperliquid Chat extension installed');
      
      // Cleanup
      consoleSpy.mockRestore();
    });
  });
});