// Shared, testable chat module extracted from content script

export class HyperliquidChat {
  constructor(config = {}) {
    this.isVisible = false;
    this.currentPair = '';
    this.currentMarket = '';
    this.walletAddress = '';
    this.messages = [];
    this.wakuClient = null;
    this.jwtToken = null;
    this.availableNames = [];
    this.selectedName = '';
    this.autoScroll = true;
    this.backendPort = config.backendPort || 3001;

    // Inject a bridge script into the page to access window.ethereum in the page context
    if (!window.DISABLE_WALLET_BRIDGE) {
      this.injectWalletBridge();
    }
  }

  async init() {
    this.detectMarketInfo();
    this.createChatWidget();
    this.setupMessageListener();
    this.startMarketMonitoring();
  }

  // Request accounts via injected wallet bridge
  requestAccounts() {
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random();
      const handler = (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'HL_CONNECT_WALLET_RESPONSE' || event.data.id !== id) return;
        window.removeEventListener('message', handler);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.accounts);
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'HL_CONNECT_WALLET_REQUEST', id }, '*');
    });
  }

  // Ask page context to sign a message
  signMessage(message) {
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random();
      const handler = (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'HL_SIGN_RESPONSE' || event.data.id !== id) return;
        window.removeEventListener('message', handler);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.signature);
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'HL_SIGN_REQUEST', id, message, address: this.walletAddress }, '*');
    });
  }

  // Inject wallet bridge
  injectWalletBridge() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('wallet-bridge.js');
      (document.head || document.documentElement).appendChild(script);
      script.onload = () => script.remove();
    } catch (_) {
      // ignore in non-browser envs
    }
  }

  // Wallet connection flow using bridge + optional backend auth
  async connectWallet() {
    try {
      const accounts = await this.requestAccounts();
      if (accounts && accounts.length > 0) {
        this.walletAddress = accounts[0];
        this.availableNames = await this.fetchHLNames(this.walletAddress);
        this.selectedName = this.availableNames[0] || '';

        try {
          await this.handleBackendAuth();
        } catch (_) {
          alert('Authentication failed');
        }

        chrome.storage.local.set({
          walletConnected: true,
          walletAddress: this.walletAddress,
          availableNames: this.availableNames,
          selectedName: this.selectedName,
          hasBackendAuth: !!this.jwtToken,
        }).catch(() => {});

        chrome.runtime.sendMessage({
          action: 'walletConnected',
          walletAddress: this.walletAddress,
          availableNames: this.availableNames,
          selectedName: this.selectedName,
          hasBackendAuth: !!this.jwtToken,
        }).catch(() => {});

        await this.loadChatHistoryWithRetry();
        this.subscribeBroadcast();
      } else {
        alert('No accounts returned. Please ensure your wallet is unlocked and try again.');
      }
    } catch (error) {
      alert(error?.message || 'Failed to connect wallet. Please try again.');
    }
  }

  async handleBackendAuth() {
    const ts = Date.now();
    const loginMsg = `HyperLiquidChat login ${ts}`;
    const signature = await this.signMessage(loginMsg);
    const resp = await fetch(`http://localhost:${this.backendPort}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: this.walletAddress, signature, timestamp: ts }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data?.error || 'Authentication failed');
    }
    const data = await resp.json();
    this.jwtToken = data.token;
  }

  // Waku hooks are set externally; this class only coordinates calls
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
    if (input) input.placeholder = connected ? 'Type your message...' : 'Waku not connected. Messages may not send.';
    if (sendButton) sendButton.disabled = !connected;
  }

  detectMarketInfo() {
    // Override when running in standalone tab
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
      pairElement =
        document.querySelector('.sc-bjfHbI.bFBYgR') ||
        document.querySelector("[data-testid='trading-pair']") ||
        document.querySelector('.trading-pair');
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
    const spotElement = document.querySelector(
      'div[style*="background: rgb(7, 39, 35)"] .sc-bjfHbI.jxtURp.body12Regular',
    );
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
    let startX, startY, startLeft, startTop, isDragging = false;
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
    const roomId = `${this.currentPair}_${this.currentMarket}`;
    const isConnected = !!this.walletAddress;
    return `
      <div class="hl-chat-container ${this.isVisible ? 'visible' : ''}">
        <div class="hl-chat-header">
          <div class="hl-chat-title">
            <span class="hl-chat-pair">${this.currentPair}</span>
            <span class="hl-chat-market">${this.currentMarket} Chat</span>
          </div>
          <div class="hl-chat-autoscroll">
            <input type="checkbox" id="autoScrollCheckbox" ${this.autoScroll ? 'checked' : ''}>
            <label for="autoScrollCheckbox">Auto-scroll</label>
          </div>
          <div class="hl-chat-controls">
            ${window.IS_STANDALONE_CHAT ? `<button class="hl-chat-popin" id="popInChat" title="Return to page">⇦</button>` : `<button class="hl-chat-popout" id="popOutChat" title="Open in new tab">↗</button>`}
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
              <option value="" ${this.selectedName === '' ? 'selected' : ''}>${this.formatAddress(this.walletAddress)}</option>
              ${this.availableNames.map(n => `<option value="${n}" ${n === this.selectedName ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </div>
          <div class="hl-chat-input-container">
            <input type="text" class="hl-chat-input" id="messageInput" placeholder="Chat with ${roomId} traders..." maxlength="500" ${!this.jwtToken && !this.wakuClient ? 'disabled' : ''} />
            <button class="hl-send-btn" id="sendMessage" ${!this.jwtToken && !this.wakuClient ? 'disabled style=\"opacity: 0.5; cursor: not-allowed;\"' : ''}>Send</button>
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
      const displayName = msg.name ? msg.name : this.formatAddress(msg.address);
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
    const connectWallet = document.getElementById('connectWallet');
    if (connectWallet) connectWallet.addEventListener('click', () => this.connectWallet());
    const sendMessage = document.getElementById('sendMessage');
    if (sendMessage) sendMessage.addEventListener('click', async () => { await this.sendMessage(); });
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
        chrome.runtime.sendMessage({ action: 'openStandaloneChat', pair: this.currentPair, market: this.currentMarket });
      });
    } else {
      const popIn = document.getElementById('popInChat');
      if (popIn) popIn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'showChat', pair: this.currentPair, market: this.currentMarket });
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
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
    // With Waku client, subscription is handled by subscribeToMessages
    this.subscribeToMessages();
  }

  async subscribeToMessages() {
    if (!this.wakuClient) return;
    this.wakuClient.setRoom(this.currentPair, this.currentMarket);
    try { await this.wakuClient.subscribe(); } catch (e) { console.error('Failed to subscribe to Waku messages:', e); }
  }

  async sendMessage() {
    if (this.wakuClient) return this.sendMessageViaWaku();
    // Backend fallback used in tests
    const input = document.getElementById('messageInput');
    let content = (input?.value || '').trim();
    if (content.length > 500) { content = content.substring(0, 500); console.warn('Message truncated to 500 characters'); }
    if (!content || !this.walletAddress) return;
    if (!this.jwtToken) {
      alert('Please reconnect your wallet to send messages');
      return;
    }
    const timestamp = Date.now();
    const nonce = timestamp + Math.random().toString(36).substr(2, 9);
    const messageObj = {
      address: this.walletAddress,
      name: this.selectedName,
      content,
      timestamp,
      pair: this.currentPair,
      market: this.currentMarket,
      room: `${this.currentPair}_${this.currentMarket}`,
      nonce,
    };
    const messageString = JSON.stringify(messageObj);
    try {
      const signature = await this.signMessage(messageString);
      // Optimistic UI
      this.messages.push({ ...messageObj });
      if (input) input.value = '';
      const messagesContainer = document.getElementById('chatMessages');
      if (messagesContainer) messagesContainer.innerHTML = this.renderMessages();
      this.scrollToBottom();
      const response = await fetch(`http://localhost:${this.backendPort}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.jwtToken}` },
        body: JSON.stringify({ signature, message: messageString }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }
      // Broadcast to other clients for realtime update
      if (this.realtimeChannel) {
        this.realtimeChannel.send({
          type: 'broadcast',
          event: 'new-message',
          payload: { ...messageObj },
        });
      }
    } catch (error) {
      // Remove optimistic message on error
      this.messages = this.messages.filter((msg) => !(msg.timestamp === timestamp && msg.address === this.walletAddress));
      const messagesContainer = document.getElementById('chatMessages');
      if (messagesContainer) messagesContainer.innerHTML = this.renderMessages();
      this.scrollToBottom();
      let errorMessage = error.message || 'Failed to send message';
      if (errorMessage.includes('rate limit')) errorMessage = 'Too many messages! Please wait a moment before sending again.';
      else if (errorMessage.includes('stale timestamp')) errorMessage = 'Message expired. Please try again.';
      else if (errorMessage.includes('signature mismatch')) errorMessage = 'Signature verification failed. Please reconnect your wallet.';
      alert(`Failed to send message: ${errorMessage}`);
    }
  }

  async sendMessageViaWaku() {
    const input = document.getElementById('messageInput');
    const content = (input?.value || '').trim();
    if (!content) return;
    if (!this.walletAddress) { alert('Please connect your wallet first'); return; }
    try {
      this.wakuClient.setWalletInfo(this.walletAddress, this.selectedName);
      const timestamp = Date.now();
      const dataToSign = JSON.stringify({ timestamp, content });
      const signature = await this.signMessage(dataToSign);
      const optimistic = await this.wakuClient.sendMessage(content, signature);
      this.messages.push(optimistic);
      if (input) input.value = '';
      const container = document.getElementById('chatMessages');
      if (container) container.innerHTML = this.renderMessages();
      this.scrollToBottom();
    } catch (error) {
      alert('Failed to send message. Please try again.');
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
    window.chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'toggleChat') this.showChat();
      else if (request.action === 'showChat' && !window.IS_STANDALONE_CHAT) {
        this.currentPair = request.pair || this.currentPair;
        this.currentMarket = request.market || this.currentMarket;
        this.showChatDirect();
      } else if (request.action === 'hideChat' && !window.IS_STANDALONE_CHAT) this.hideChat();
      else if (request.action === 'getCurrentRoom') {
        sendResponse({ pair: this.currentPair, market: this.currentMarket, messages: this.messages, walletAddress: this.walletAddress, availableNames: this.availableNames, selectedName: this.selectedName });
        return true;
      } else if (request.action === 'requestWalletConnection') this.connectWallet();
      else if (request.action === 'sendMessage') {
        if (this.walletAddress) {
          this.selectedName = request.selectedName || this.selectedName;
          const messageInput = document.getElementById('messageInput');
          if (messageInput) { messageInput.value = request.content; this.sendMessage(); }
        }
      } else if (request.action === 'signMessage') {
        if (this.walletAddress) {
          this.signMessage(request.message).then((signature) => { sendResponse({ signature }); }).catch((error) => { sendResponse({ error: error.message }); });
          return true;
        } else sendResponse({ error: 'Wallet not connected' });
      } else if (request.action === 'roomChange' && window.IS_STANDALONE_CHAT) {
        const { pair, market } = request; if (!pair || !market) return;
        const oldRoom = `${this.currentPair}_${this.currentMarket}`; const newRoom = `${pair}_${market}`;
        if (oldRoom === newRoom) return;
        this.currentPair = pair; this.currentMarket = market; window.CHAT_PAIR_OVERRIDE = pair; window.CHAT_MARKET_OVERRIDE = market;
        this.messages = []; this.updateChatHeader();
        const messagesContainer = document.getElementById('chatMessages');
        if (messagesContainer) messagesContainer.innerHTML = '<div class="hl-loading">Loading…</div>';
        this.loadChatHistoryWithRetry().then(() => { this.subscribeBroadcast(); });
      } else if (request.action === 'syncMessages') {
        sendResponse({ messages: this.messages, currentPair: this.currentPair, currentMarket: this.currentMarket });
        return true;
      }
    });
  }

  formatAddress(address) { return `${address.slice(0, 6)}...${address.slice(-4)}`; }
  formatTime(timestamp) { return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
  scrollToBottom() { if (!this.autoScroll) return; const messagesContainer = document.getElementById('chatMessages'); if (messagesContainer) { messagesContainer.scrollTop = messagesContainer.scrollHeight; } }
  toggleChat() { this.isVisible = !this.isVisible; const container = document.querySelector('.hl-chat-container'); if (container) { container.style.opacity = this.isVisible ? '1' : '0'; container.style.pointerEvents = this.isVisible ? 'auto' : 'none'; container.classList.toggle('visible', this.isVisible); } }
  showChat() { this.showChatDirect(); }
  showChatDirect() { this.isVisible = true; let widget = document.getElementById('hyperliquid-chat-widget'); if (!widget) { this.createChatWidget(); widget = document.getElementById('hyperliquid-chat-widget'); } const container = widget?.querySelector('.hl-chat-container'); if (container) container.classList.add('visible'); }
  hideChat() { this.isVisible = false; const widget = document.getElementById('hyperliquid-chat-widget'); if (widget) widget.remove(); }

  async fetchHLNames(address) {
    try {
      const resp = await fetch(`https://api.hlnames.xyz/utils/names_owner/${address}`, { headers: { 'X-API-Key': 'CPEPKMI-HUSUX6I-SE2DHEA-YYWFG5Y' } });
      if (!resp.ok) return [];
      const data = await resp.json();
      if (!Array.isArray(data)) return [];
      return data.map((x) => x.name).filter(Boolean);
    } catch (_) { return []; }
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
}
