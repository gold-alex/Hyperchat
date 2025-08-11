// Tests for popup.js

describe('Popup Script', () => {
  // Setup DOM before tests
  beforeEach(() => {
    // Create the DOM structure needed for the popup
    document.body.innerHTML = `
      <div id="popup-root"></div>
    `;

    // Mock chrome.tabs API
    chrome.tabs.query = jest.fn();
    chrome.tabs.sendMessage = jest.fn();
    chrome.tabs.create = jest.fn();

    // Mock window.close
    window.close = jest.fn();
  });

  // Clean up after each test
  afterEach(() => {
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  test('should render UI with header text and "Open Chat" button on DOMContentLoaded', () => {
    // Load popup script
    require('../popup.js');

    // Simulate DOMContentLoaded event
    const event = new Event('DOMContentLoaded');
    document.dispatchEvent(event);

    // Verify the header text is rendered
    const headerText = document.querySelector('div[style*="color: #50d2c1"]');
    expect(headerText).not.toBeNull();
    expect(headerText.textContent.trim()).toBe('Hyperliquid Chat');

    // Verify the instruction text is rendered
    const instructionText = document.querySelector('div[style*="color: #a0a0a0"]');
    expect(instructionText).not.toBeNull();
    expect(instructionText.textContent.trim()).toBe('Navigate to app.hyperliquid.xyz/trade to start chatting');

    // Verify the "Open Chat" button exists
    const openChatButton = document.getElementById('openChat');
    expect(openChatButton).not.toBeNull();
    expect(openChatButton.textContent.trim()).toBe('Open Chat');
  });

  test('clicking "Open Chat" when on trade page should send toggleChat message and close window', () => {
    // Load popup script
    require('../popup.js');

    // Simulate DOMContentLoaded event
    const event = new Event('DOMContentLoaded');
    document.dispatchEvent(event);

    // Mock chrome.tabs.query to return a tab with the trade URL
    chrome.tabs.query.mockImplementation((query, callback) => {
      callback([{ id: 123, url: 'https://app.hyperliquid.xyz/trade/ETH-USDC' }]);
    });

    // Click the "Open Chat" button
    const openChatButton = document.getElementById('openChat');
    openChatButton.click();

    // Verify that chrome.tabs.sendMessage was called with the correct parameters
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(123, { action: 'toggleChat' });
    
    // Verify that window.close was called
    expect(window.close).toHaveBeenCalled();
    
    // Verify that chrome.tabs.create was not called
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  test('clicking "Open Chat" when not on trade page should create new tab with trade URL', () => {
    // Load popup script
    require('../popup.js');

    // Simulate DOMContentLoaded event
    const event = new Event('DOMContentLoaded');
    document.dispatchEvent(event);

    // Mock chrome.tabs.query to return a tab with a non-trade URL
    chrome.tabs.query.mockImplementation((query, callback) => {
      callback([{ id: 123, url: 'https://example.com' }]);
    });

    // Click the "Open Chat" button
    const openChatButton = document.getElementById('openChat');
    openChatButton.click();

    // Verify that chrome.tabs.create was called with the correct URL
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://app.hyperliquid.xyz/trade' });
    
    // Verify that chrome.tabs.sendMessage was not called
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    
    // Verify that window.close was not called
    expect(window.close).not.toHaveBeenCalled();
  });
});
