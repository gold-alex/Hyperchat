// EIP-712 Typed Data Definitions for Hyperliquid Chat
// This provides structured, human-readable signatures that wallets can properly display

const EIP712_DOMAIN = {
  name: 'Hyperliquid Chat',
  version: '1'
};

// Domain type definition
const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' }
];

// Login message type
const LOGIN_TYPE = {
  Login: [
    { name: 'message', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'string' }
  ]
};

// Chat message type  
const MESSAGE_TYPE = {
  ChatMessage: [
    { name: 'room', type: 'string' },
    { name: 'content', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'string' }
  ]
};

// Helper to create EIP-712 typed data for login
function createLoginTypedData(timestamp, nonce) {
  return {
    domain: EIP712_DOMAIN,
    primaryType: 'Login',
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPE,
      ...LOGIN_TYPE
    },
    message: {
      message: 'Sign in to Hyperliquid Chat',
      timestamp: timestamp,
      nonce: nonce || Math.random().toString(36).substring(2, 15)
    }
  };
}

// Helper to create EIP-712 typed data for chat messages
function createMessageTypedData(room, content, timestamp, nonce) {
  return {
    domain: EIP712_DOMAIN,
    primaryType: 'ChatMessage',
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPE,
      ...MESSAGE_TYPE
    },
    message: {
      room: room,
      content: content,
      timestamp: timestamp,
      nonce: nonce
    }
  };
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    EIP712_DOMAIN,
    EIP712_DOMAIN_TYPE,
    LOGIN_TYPE,
    MESSAGE_TYPE,
    createLoginTypedData,
    createMessageTypedData
  };
}