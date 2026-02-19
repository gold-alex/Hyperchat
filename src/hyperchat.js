import { verifyMessage } from 'viem';
import {
  buildSafeNameOptions,
  escapeUnsafeHtml,
  sanitizeDisplayName,
  sanitizeRoomId,
} from './ui/chat-html-safety.js';

// Test if we are undefined or in test environment
const isTestEnv = typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test';

const resolveExtensionAPI = (override) => {
  if (override) return override;
  if (typeof globalThis !== 'undefined') {
    if (globalThis.browser && globalThis.browser.runtime) return globalThis.browser;
    if (globalThis.chrome && globalThis.chrome.runtime) return globalThis.chrome;
  }
  return null;
};

const isPromise = (value) => !!value && typeof value.then === 'function';

const storageGet = async (api, keys) => {
  if (!api?.storage?.local?.get) return {};
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const done = (items) => {
        if (settled) return;
        settled = true;
        resolve(items || {});
      };
      const result = api.storage.local.get(keys, done);
      if (isPromise(result)) {
        result.then(done).catch(() => done({}));
      } else if (api.storage.local.get.length <= 1) {
        done(result);
      }
    });
  } catch (_) {
    return {};
  }
};

const storageSet = async (api, data) => {
  if (!api?.storage?.local?.set) return;
  try {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const result = api.storage.local.set(data, done);
      if (isPromise(result)) {
        result.then(done).catch(done);
      } else if (api.storage.local.set.length <= 1) {
        done();
      }
    });
  } catch (_) {
    // Ignore storage errors in non-extension contexts
  }
};

const runtimeSendMessage = async (api, payload) => {
  if (!api?.runtime?.sendMessage) return undefined;
  try {
    if (api.runtime.sendMessage.length > 1) {
      return await new Promise((resolve) => api.runtime.sendMessage(payload, (response) => resolve(response)));
    }
    const result = api.runtime.sendMessage(payload);
    if (isPromise(result)) return await result;
    return result;
  } catch (error) {
    console.warn('runtimeSendMessage failed', error);
    return undefined;
  }
};

const runtimeGetURL = (api, path) => {
  if (api?.runtime?.getURL) return api.runtime.getURL(path);
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) return chrome.runtime.getURL(path);
  return path;
};

const addRuntimeListener = (api, handler) => {
  if (!api?.runtime?.onMessage?.addListener) return () => {};
  const wrapped = (request, sender, sendResponse) => {
    Promise.resolve()
      .then(() => handler(request, sender))
      .then((result) => {
        if (typeof sendResponse === 'function') {
          try { sendResponse(result); } catch (_) {}
        }
      })
      .catch(() => {
        if (typeof sendResponse === 'function') {
          try { sendResponse(undefined); } catch (_) {}
        }
      });
    return true;
  };
  api.runtime.onMessage.addListener(wrapped);
  return () => {
    try { api.runtime.onMessage.removeListener(wrapped); } catch (_) {}
  };
};

export class Hyperchat {
  constructor(config = {}) {
    this.isVisible = false;
    this.currentPair = '';
    this.currentMarket = '';
    this.walletAddress = '';
    this.messages = [];
    this.wakuClient = null;
    this.availableNames = [];
    this.selectedName = '';
    this.autoScroll = true;
    this.extensionAPI = resolveExtensionAPI(config.extensionAPI);
    this.realtimeChannel = null;
    this.hlNamesApiKey = typeof config.hlNamesApiKey === 'string' ? config.hlNamesApiKey.trim() : '';
    this.walletBridgeAuthToken = null;

    if (!window.DISABLE_WALLET_BRIDGE) {
      this.injectWalletBridge();
    }
  }

  get api() {
    if (!this.extensionAPI) this.extensionAPI = resolveExtensionAPI();
    return this.extensionAPI;
  }

  async init() {
    console.log('Initializing Hyperchat...');
    this.detectMarketInfo();
    this.createChatWidget();
    this.setupMessageListener();
    this.startMarketMonitoring();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await this.restoreWalletConnection();

    try {
      console.log('Initializing chat in read-only mode...');
      console.log(`Current trading pair: ${this.currentPair}, market: ${this.currentMarket}`);
      if (window.IS_STANDALONE_CHAT) this.showChat();
      await this.loadChatHistoryWithRetry();
      this.subscribeToMessages();
    } catch (error) {
      console.error('Failed to initialize read-only chat:', error);
      const messagesContainer = document.getElementById('chatMessages');
      if (messagesContainer) {
        messagesContainer.innerHTML = '<div class="hl-error">Failed to load chat history. Please refresh the page.</div>';
      }
    }
  }

  handleNewMessage(message) {
    this.messages.push(message);
    const messagesContainer = document.getElementById('chatMessages');
    if (messagesContainer) {
      messagesContainer.innerHTML = this.renderMessages();
      this.scrollToBottom();
    }
  }

  handleHistoryLoaded(messages) {
    this.messages = messages;
    const messagesContainer = document.getElementById('chatMessages');
    if (messagesContainer) {
      messagesContainer.innerHTML = this.renderMessages();
      this.scrollToBottom();
    }
  }

  handleConnectionStatusChange(connected) {
    const input = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendMessage');
    if (input) {
      input.placeholder = connected ? 'Type your message...' : 'Waku not connected. Messages may not send.';
    }
    if (sendButton) sendButton.disabled = !connected;
  }

  detectMarketInfo() {
    console.log('Detecting market info...');
    if (window.CHAT_PAIR_OVERRIDE) {
      this.currentPair = window.CHAT_PAIR_OVERRIDE;
      this.currentMarket = window.CHAT_MARKET_OVERRIDE || 'Perps';
      return;
    }
    let pairElement = document.querySelector('#coinInfo > div > div:nth-child(2) > div:nth-child(1) > div > div > div > div:nth-child(2) > div');
    if (!pairElement || !pairElement.textContent.trim()) {
      pairElement = document.querySelector('#root > div:nth-child(2) > div:nth-child(3) > div > div:nth-child(1) > div:nth-child(1) > div > div:nth-child(1) > div > div > div > div:nth-child(2) > div');
    }
    if (!pairElement || !pairElement.textContent.trim()) {
      const coinIcon = document.querySelector('img[alt][src*="/coins/"]');
      if (coinIcon) {
        let container = coinIcon.closest('div[style*="display"]');
        if (container && container.parentElement) {
          const textElements = container.parentElement.querySelectorAll('div');
          for (const el of textElements) {
            const text = el.textContent.trim();
            if (text && !text.includes('Welcome') && (text.includes('-USD') || text.match(/^[A-Z]+-USD[C]?$/))) {
              pairElement = el;
              break;
            }
          }
        }
      }
    }
    if (!pairElement || !pairElement.textContent.trim()) {
      pairElement = document.querySelector('.sc-bjfHbI.bFBYgR') || document.querySelector('[data-testid="trading-pair"]') || document.querySelector('.trading-pair');
    }
    if (pairElement) {
      let newPair = pairElement.textContent.trim();
      if (newPair.includes('Welcome')) {
        const match = newPair.match(/([A-Z]+[-]USD[C]?)/);
        if (match) newPair = match[1];
      }
      if (newPair && newPair !== this.currentPair) this.currentPair = newPair;
    } else {
      this.currentPair = 'UNKNOWN';
    }
    const spotElement = document.querySelector('div[style*="background: rgb(7, 39, 35)"] .sc-bjfHbI.jxtURp.body12Regular');
    const newMarket = spotElement && spotElement.textContent.includes('Spot') ? 'Spot' : 'Perps';
    if (newMarket !== this.currentMarket) this.currentMarket = newMarket;
  }

  createChatWidget() {
    const existing = document.getElementById('hyperliquid-chat-widget');
    if (existing) existing.remove();
    const widget = document.createElement('div');
    widget.id = 'hyperliquid-chat-widget';
    widget.className = 'hl-chat-widget';
    widget.style.resize = 'both';
    widget.style.overflow = 'hidden';
    widget.innerHTML = this.getChatHTML();
    document.body.appendChild(widget);
    this.enableDrag(widget, widget.querySelector('#moveChat') || widget.querySelector('.hl-chat-header'));
    this.setupEventListeners();
  }

  enableDrag(widget, handleEl) {
    const dragHandle = handleEl;
    if (!dragHandle) return;
    let startX;
    let startY;
    let startLeft;
    let startTop;
    let isDragging = false;
    dragHandle.style.cursor = 'move';
    const onMouseMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      widget.style.left = `${startLeft + dx}px`;
      widget.style.top = `${startTop + dy}px`;
    };
    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    dragHandle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = widget.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  getChatHTML() {
    const roomId = sanitizeRoomId(this.currentPair, this.currentMarket);
    const safePair = escapeUnsafeHtml(this.currentPair);
    const safeMarketLabel = `${escapeUnsafeHtml(this.currentMarket)} Chat`;
    const safeWalletLabel = escapeUnsafeHtml(this.formatAddress(this.walletAddress));
    const safeNameOptions = buildSafeNameOptions(this.availableNames, this.selectedName);
    const isConnected = !!this.walletAddress;
    const isDisabled = !this.walletAddress || !this.wakuClient;
    return `
      <div class="hl-chat-container ${this.isVisible ? 'visible' : ''}">
        <div class="hl-chat-header">
          <div class="hl-chat-title">
            <span class="hl-chat-pair">${safePair}</span>
            <span class="hl-chat-market">${safeMarketLabel}</span>
          </div>
          <div class="hl-chat-autoscroll">
            <input type="checkbox" id="autoScrollCheckbox" ${this.autoScroll ? 'checked' : ''}>
            <label for="autoScrollCheckbox">Auto-scroll</label>
          </div>
          <div class="hl-chat-controls">
            ${window.IS_STANDALONE_CHAT ? '<button class="hl-chat-popin" id="popInChat" title="Return to page">⇦</button>' : '<button class="hl-chat-popout" id="popOutChat" title="Open in new tab">↗</button>'}
            <button class="hl-chat-minimize" id="minimizeChat" title="Hide chat">–</button>
            <button class="hl-chat-close" id="closeChat">×</button>
          </div>
        </div>
        <div class="hl-chat-content">
          <div class="hl-chat-messages" id="chatMessages">${this.renderMessages()}</div>
          ${!isConnected ? `
          <div class="hl-chat-auth-bar" id="chatAuthBar">
            <div class="hl-auth-message">
              <span>Connect wallet to send messages</span>
              <button class="hl-connect-btn-small" id="connectWallet">Connect</button>
            </div>
          </div>
          ` : `
          <div class="hl-name-bar">
            <label class="hl-name-label">As:</label>
            <select id="hlNameSelect" class="hl-name-select-input">
              <option value="" ${this.selectedName === '' ? 'selected' : ''}>${safeWalletLabel}</option>
              ${safeNameOptions}
            </select>
          </div>
          <div class="hl-chat-input-container">
            <input type="text" class="hl-chat-input" id="messageInput" placeholder="Chat with ${roomId} traders..." maxlength="500" ${isDisabled ? 'disabled' : ''} />
            <button class="hl-send-btn" id="sendMessage" ${isDisabled ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>Send</button>
          </div>
          `}
        </div>
        <div class="hl-chat-toggle" id="chatToggle"><span>💬</span></div>
      </div>`;
  }

  renderMessages() {
    if (this.messages.length === 0) return '';
    return this.messages.map((msg) => {
      const isOwn = msg.address === this.walletAddress;
      const displayName = sanitizeDisplayName(msg.name, this.formatAddress(msg.address));
      return `
      <div class="hl-message ${isOwn ? 'own' : ''}">
        <div class="hl-message-header">
          <span class="hl-message-address">${displayName}</span>
          <span class="hl-message-time">${this.formatTime(msg.timestamp)}</span>
        </div>
        <div class="hl-message-content">${this.escapeHtml(msg.content)}</div>
      </div>`;
    }).join('');
  }

  setupEventListeners() {
    const chatToggle = document.getElementById('chatToggle');
    if (chatToggle) chatToggle.addEventListener('click', () => this.toggleChat());
    const closeChat = document.getElementById('closeChat');
    if (closeChat) closeChat.addEventListener('click', () => this.hideChat());
    const minimizeChat = document.getElementById('minimizeChat');
    if (minimizeChat) minimizeChat.addEventListener('click', () => this.hideChat());
    const connectWalletBtn = document.getElementById('connectWallet');
    if (connectWalletBtn) connectWalletBtn.addEventListener('click', () => this.connectWallet());
    const sendMessageBtn = document.getElementById('sendMessage');
    if (sendMessageBtn) sendMessageBtn.addEventListener('click', async () => { await this.sendMessage(); });
    const messageInput = document.getElementById('messageInput');
    if (messageInput) messageInput.addEventListener('keypress', async (e) => { if (e.key === 'Enter') await this.sendMessage(); });
    const autoScrollCheckbox = document.getElementById('autoScrollCheckbox');
    if (autoScrollCheckbox) autoScrollCheckbox.addEventListener('change', (e) => { this.autoScroll = e.target.checked; if (this.autoScroll) this.scrollToBottom(); });
    const nameSelect = document.getElementById('hlNameSelect');
    if (nameSelect) nameSelect.addEventListener('change', (e) => { this.selectedName = e.target.value; });
    if (!window.IS_STANDALONE_CHAT) {
      const popBtn = document.getElementById('popOutChat');
      if (popBtn) popBtn.addEventListener('click', () => {
        this.hideChat();
        runtimeSendMessage(this.api, { action: 'openStandaloneChat', pair: this.currentPair, market: this.currentMarket });
      });
    } else {
      const popIn = document.getElementById('popInChat');
      if (popIn) popIn.addEventListener('click', () => {
        runtimeSendMessage(this.api, { action: 'showChat', pair: this.currentPair, market: this.currentMarket });
        window.close();
      });
    }
  }

  async loadChatHistoryWithRetry(maxRetries = 3) {
    if (!this.wakuClient) throw new Error('Waku client not available');
    return this.loadChatHistoryFromWakuWithRetry(maxRetries);
  }

  async loadChatHistoryFromWakuWithRetry(maxRetries = 3) {
    if (!this.wakuClient) throw new Error('Waku client not initialized');
    this.wakuClient.setRoom(this.currentPair, this.currentMarket);
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        await this.wakuClient.loadHistoryWithRetry(maxRetries);
        return;
      } catch (error) {
        if (attempt === maxRetries) {
          const messagesContainer = document.getElementById('chatMessages');
          if (messagesContainer) messagesContainer.innerHTML = `<div class="hl-error">Failed to load chat from Waku after ${maxRetries} attempts. <button onclick=\"location.reload()\">Refresh Page</button></div>`;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  subscribeBroadcast() {
    this.subscribeToMessages();
  }

  async subscribeToMessages() {
    if (!this.wakuClient) return;
    this.wakuClient.setRoom(this.currentPair, this.currentMarket);
    try {
      await this.wakuClient.subscribe();
    } catch (error) {
      console.error('Failed to subscribe to Waku messages:', error);
    }
  }

  async sendMessage() {
    if (!this.wakuClient) {
      this.showError('Waku client not yet initialized.');
      return;
    }
    return this.sendMessageViaWaku();
  }

  async sendMessageViaWaku() {
    const input = document.getElementById('messageInput');
    let content = (input?.value || '').trim();
    if (content.length > 500) {
      content = content.substring(0, 500);
      console.warn('Message truncated to 500 characters');
    }
    if (!content) return;
    if (!this.walletAddress) {
      this.showError('Connect wallet first.');
      return;
    }
    try {
      this.wakuClient.setRoom(this.currentPair, this.currentMarket);
      this.wakuClient.setWalletInfo(this.walletAddress, this.selectedName);
      const optimistic = await this.wakuClient.sendMessage(content);
      this.messages.push(optimistic);
      if (input) input.value = '';
      const container = document.getElementById('chatMessages');
      if (container) container.innerHTML = this.renderMessages();
      this.scrollToBottom();
    } catch (error) {
      const friendly = error?.message ? error.message : 'Check console.';
      this.showError(`Failed to send message: ${friendly}`);
    }
  }

  updateChatHeader() {
    const pairElement = document.querySelector('.hl-chat-pair');
    const marketElement = document.querySelector('.hl-chat-market');
    const inputElement = document.getElementById('messageInput');
    if (pairElement) pairElement.textContent = this.currentPair;
    if (marketElement) marketElement.textContent = `${this.currentMarket} Chat`;
    const roomId = `${this.currentPair}_${this.currentMarket}`;
    if (inputElement) inputElement.placeholder = `Chat with ${roomId} traders...`;
  }

  setupMessageListener() {
    this.onMessageCleanup = addRuntimeListener(this.api, async (request) => {
      if (request.action === 'toggleChat') this.showChat();
      else if (request.action === 'showChat' && !window.IS_STANDALONE_CHAT) {
        this.currentPair = request.pair || this.currentPair;
        this.currentMarket = request.market || this.currentMarket;
        this.showChatDirect();
      } else if (request.action === 'hideChat' && !window.IS_STANDALONE_CHAT) this.hideChat();
      else if (request.action === 'getCurrentRoom') {
        return { pair: this.currentPair, market: this.currentMarket, messages: this.messages, walletAddress: this.walletAddress, availableNames: this.availableNames, selectedName: this.selectedName };
      } else if (request.action === 'requestWalletConnection') this.connectWallet();
      else if (request.action === 'sendMessage') {
        if (this.walletAddress) {
          this.selectedName = request.selectedName || this.selectedName;
          const messageInput = document.getElementById('messageInput');
          if (messageInput) {
            messageInput.value = request.content;
            this.sendMessage();
          }
        }
      } else if (request.action === 'signMessage') {
        if (this.walletAddress) {
          try {
            const signature = await this.signMessage(request.message);
            return { signature };
          } catch (error) {
            return { error: error.message };
          }
        }
        return { error: 'Wallet not connected' };
      } else if (request.action === 'roomChange' && window.IS_STANDALONE_CHAT) {
        const { pair, market } = request;
        if (!pair || !market) return;
        const oldRoom = `${this.currentPair}_${this.currentMarket}`;
        const newRoom = `${pair}_${market}`;
        if (oldRoom === newRoom) return;
        this.currentPair = pair;
        this.currentMarket = market;
        window.CHAT_PAIR_OVERRIDE = pair;
        window.CHAT_MARKET_OVERRIDE = market;
        this.messages = [];
        this.updateChatHeader();
        const messagesContainer = document.getElementById('chatMessages');
        if (messagesContainer) messagesContainer.innerHTML = '<div class="hl-loading">Loading…</div>';
        await this.loadChatHistoryWithRetry();
        await this.subscribeBroadcast();
      } else if (request.action === 'syncMessages') {
        return { messages: this.messages, currentPair: this.currentPair, currentMarket: this.currentMarket };
      }
      return undefined;
    });
  }

  formatAddress(address) {
    const normalized = String(address ?? '');
    if (normalized.length <= 10) return normalized;
    return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
  }

  formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  escapeHtml(text) {
    return escapeUnsafeHtml(text);
  }

  notifyUser(message) {
    if (typeof alert !== 'undefined' && typeof alert === 'function') {
      try {
        alert(message);
      } catch (_) {
        // noop for tests/non-browser contexts
      }
    }
  }

  showError(message, showInUI = true) {
    console.error(message);
    if (showInUI) {
      const messagesContainer = document.getElementById('chatMessages');
      if (messagesContainer) {
        const existingError = messagesContainer.querySelector('.hl-error');
        if (existingError) existingError.remove();
        const errorDiv = document.createElement('div');
        errorDiv.className = 'hl-error';
        errorDiv.textContent = message;
        messagesContainer.insertBefore(errorDiv, messagesContainer.firstChild);
        setTimeout(() => {
          if (errorDiv.parentNode) errorDiv.remove();
        }, 5000);
      }
    }
    this.notifyUser(message);
  }

  scrollToBottom() {
    if (!this.autoScroll) return;
    const messagesContainer = document.getElementById('chatMessages');
    if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  toggleChat() {
    this.isVisible = !this.isVisible;
    const container = document.querySelector('.hl-chat-container');
    if (container) {
      container.style.opacity = this.isVisible ? '1' : '0';
      container.style.pointerEvents = this.isVisible ? 'auto' : 'none';
      container.classList.toggle('visible', this.isVisible);
    }
  }

  showChat() {
    this.showChatDirect();
  }

  showChatDirect() {
    this.isVisible = true;
    let widget = document.getElementById('hyperliquid-chat-widget');
    if (!widget) {
      this.createChatWidget();
      widget = document.getElementById('hyperliquid-chat-widget');
    }
    const container = widget?.querySelector('.hl-chat-container');
    if (container) container.classList.add('visible');
  }

  hideChat() {
    this.isVisible = false;
    const widget = document.getElementById('hyperliquid-chat-widget');
    if (widget) widget.remove();
  }

  requestAccounts() {
    const authToken = this._initWalletBridgeAuth();
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random();
      const handler = (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'HL_CONNECT_WALLET_RESPONSE' || event.data.id !== id) return;
        window.removeEventListener('message', handler);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.accounts);
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'HL_CONNECT_WALLET_REQUEST', id, authToken }, '*');
    });
  }

  signMessage(message) {
    const authToken = this._initWalletBridgeAuth();
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random();
      const handler = (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'HL_SIGN_RESPONSE' || event.data.id !== id) return;
        window.removeEventListener('message', handler);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.signature);
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'HL_SIGN_REQUEST', id, message, address: this.walletAddress, authToken }, '*');
    });
  }

  _initWalletBridgeAuth() {
    if (window.DISABLE_WALLET_BRIDGE) return '';
    if (!this.walletBridgeAuthToken) {
      this.walletBridgeAuthToken = this.createBridgeAuthToken();
    }
    const initId = Date.now() + Math.random();
    window.postMessage({
      type: 'HL_BRIDGE_AUTH_INIT',
      id: initId,
      authToken: this.walletBridgeAuthToken,
    }, '*');
    return this.walletBridgeAuthToken;
  }

  createBridgeAuthToken() {
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async fetchHLNames(address) {
    try {
      const headers = this.hlNamesApiKey ? { 'X-API-Key': this.hlNamesApiKey } : undefined;
      const resp = await fetch(`https://api.hlnames.xyz/utils/names_owner/${address}`, headers ? { headers } : undefined);
      if (!resp.ok) return [];
      const data = await resp.json();
      if (!Array.isArray(data)) return [];
      return data.map((x) => x.name).filter(Boolean);
    } catch (err) {
      console.error('Error fetching HL names', err);
      return [];
    }
  }

  injectWalletBridge() {
    const api = this.api;
    const script = document.createElement('script');
    script.src = runtimeGetURL(api, 'wallet-bridge.js');
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => { script.remove(); };
  }

  startMarketMonitoring() {
    setInterval(() => {
      const prevRoom = `${this.currentPair}_${this.currentMarket}`;
      this.detectMarketInfo();
      const newRoom = `${this.currentPair}_${this.currentMarket}`;
      if (prevRoom !== newRoom) {
        this.updateChatHeader();
        this.loadChatHistoryWithRetry().then(() => this.subscribeBroadcast());
      }
    }, 3000);
  }

  async authenticateWallet() {
    if (!this.walletAddress) {
      throw new Error('Wallet not connected');
    }
    const timestamp = Date.now();
    const loginMsg = `Hyperchat login ${timestamp}`;
    const signature = await this.signMessage(loginMsg);
    const verified = await verifyMessage({
      address: this.walletAddress,
      message: loginMsg,
      signature,
    });
    if (!verified) {
      throw new Error('Signature verification failed');
    }
    return { signature, timestamp };
  }

  async connectWallet() {
    try {
      const accounts = await this.requestAccounts();
      if (accounts && accounts.length > 0) {
        this.walletAddress = accounts[0];
        try {
          await this.authenticateWallet();
        } catch (authError) {
          if (!isTestEnv) {
            console.warn('Wallet authentication failed', authError);
          }
          this.walletAddress = '';
          this.notifyUser('Signature verification failed. Check console.');
          return;
        }
        this.availableNames = await this.fetchHLNames(this.walletAddress);
        this.selectedName = this.availableNames[0] || '';
        await storageSet(this.api, {
          walletConnected: true,
          walletAddress: this.walletAddress,
          availableNames: this.availableNames,
          selectedName: this.selectedName,
        });
        await runtimeSendMessage(this.api, {
          action: 'walletConnected',
          walletAddress: this.walletAddress,
          availableNames: this.availableNames,
          selectedName: this.selectedName,
        });
        if (this.wakuClient) {
          await this.loadChatHistoryWithRetry();
          this.subscribeBroadcast();
        }
      } else {
        this.notifyUser('No accounts returned. Check console.');
      }
    } catch (error) {
      this.notifyUser(error?.message || 'Failed to connect wallet. Check console.');
    }
  }

  async restoreWalletConnection() {
    try {
      const data = await storageGet(this.api, ['walletConnected', 'walletAddress', 'availableNames', 'selectedName']);
      if (data.walletConnected && data.walletAddress) {
        this.walletAddress = data.walletAddress;
        this.availableNames = data.availableNames || [];
        this.selectedName = data.selectedName || '';
      }
    } catch (error) {
      console.warn('Failed to restore wallet connection', error);
    }
  }
}
