// Mock TextEncoder and TextDecoder for JSDOM
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;

// Mock global objects needed for tests
global.chrome = {
  runtime: {
    getURL: jest.fn((path) => `http://localhost/mock-extension/${path}`),
    onMessage: {
      addListener: jest.fn(),
    },
    sendMessage: jest.fn(),
  },
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn(),
    },
  },
  tabs: {
    query: jest.fn(),
    create: jest.fn(),
    sendMessage: jest.fn(),
  },
  scripting: {
    executeScript: jest.fn(),
  },
};

// Mock fetch
global.fetch = jest.fn();

// Mock window.supabase
global.supabase = {
  createClient: jest.fn(),
};

// Mock Date.now for consistent timestamps in tests
const mockNow = 1625097600000; // 2021-07-01T00:00:00.000Z
global.Date.now = jest.fn(() => mockNow);

// Mock postMessage and addEventListener for bridge messaging
window.postMessage = jest.fn();
const originalAddEventListener = window.addEventListener;
window.addEventListener = jest.fn().mockImplementation((event, handler) => {
  if (event !== 'message') {
    return originalAddEventListener(event, handler);
  }
});

// Helper to create DOM fixtures
global.setupTestDOM = () => {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
};

// Helper to simulate message events
global.simulateMessageEvent = (data) => {
  const messageEvent = new MessageEvent('message', {
    source: window,
    data,
  });

  // Find and call the message handler directly
  const calls = window.addEventListener.mock.calls;
  const messageHandlers = calls
    .filter(call => call[0] === 'message')
    .map(call => call[1]);

  messageHandlers.forEach(handler => handler(messageEvent));
};

// Mock dynamic imports
jest.mock('module', () => ({
  ...jest.requireActual('module'),
  import: jest.fn().mockImplementation((path) => {
    if (path.includes('supabase.js')) {
      return Promise.resolve(require('./__mocks__/supabase.js'));
    }
    return Promise.reject(new Error(`Module not mocked: ${path}`));
  }),
}));
