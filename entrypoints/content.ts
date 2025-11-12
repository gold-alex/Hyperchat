import { defineContentScript } from 'wxt/sandbox';
import '../content.css';
import { browser } from 'wxt/browser';
import { HyperliquidChat } from '../src/hyperliquid-chat.js';

// Wrap existing content script inside WXT content entrypoint
export default defineContentScript({
  matches: ['https://app.hyperliquid.xyz/trade*'],
  // Default cssInjectionMode is 'manifest'; CSS imported above will be injected
  main() {
    // BEGIN migrated content.js

    // Configuration - these should be replaced at build time (via Vite env)
    const WAKU_NODE_URI = (import.meta as any).env?.VITE_WAKU_NODE_URI || 'localhost';
    const WAKU_NODE_PORT = Number((import.meta as any).env?.VITE_WAKU_NODE_PORT) || 443;
    const WAKU_NODE_PEER_ID = (import.meta as any).env?.VITE_WAKU_NODE_PEER_ID || 'PEER_ID';
    const BACKEND_PORT = Number((import.meta as any).env?.VITE_BACKEND_PORT) || 3001;

    let wakuClient: any;
    let chatInstance: any;

    // Initialize Waku client
    async function initializeWaku() {
      try {
        const wakuModule: any = await import(chrome.runtime.getURL('lib/waku-chat-client.js'));

        // Create Waku client with configuration
        wakuClient = new wakuModule.WakuChatClient({
          wakuNodeURI: WAKU_NODE_URI,
          wakuNodePort: WAKU_NODE_PORT as any,
          wakuNodePeerId: WAKU_NODE_PEER_ID,
          onMessageReceived: (message: any) => {
            if (chatInstance) chatInstance.handleNewMessage(message);
          },
          onHistoryLoaded: (messages: any[]) => {
            if (chatInstance) chatInstance.handleHistoryLoaded(messages);
          },
          onConnectionStatusChange: (connected: boolean) => {
            if (chatInstance) chatInstance.handleConnectionStatusChange(connected);
          },
        });

        const success = await wakuClient.initialize();
        if (success) {
          console.log('Waku client initialized successfully');
        } else {
          console.error('Failed to initialize Waku client');
        }
      } catch (error) {
        console.error('Failed to initialize Waku:', error);
      } finally {
        initializeChat();
      }
    }

    // Initialize the chat once everything is ready
    function initializeChat() {
      chatInstance = new (HyperliquidChat as any)({ backendPort: BACKEND_PORT });
      chatInstance.wakuClient = wakuClient; // Pass the Waku client
      chatInstance.init();
    }

    class HyperliquidChat {
      isVisible: boolean;
      currentPair: string;
      currentMarket: string;
      walletAddress: string;
      messages: any[];
      wakuClient: any;
      jwtToken: string | null;
      availableNames: string[];
      selectedName: string;
      autoScroll: boolean;

      constructor() {
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
        this.injectWalletBridge();
      }

      async init() {
        console.log('Initializing HyperliquidChat...');
        this.detectMarketInfo();
        this.createChatWidget();
        this.setupMessageListener();
        this.startMarketMonitoring();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await this.restoreWalletConnection();

        try {
          console.log('Initializing chat in read-only mode...');
          console.log(`Current trading pair: ${this.currentPair}, market: ${this.currentMarket}`);
          if ((window as any).IS_STANDALONE_CHAT) this.showChat();
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

      // --- The rest of the original content.js methods are pasted below unchanged, except:
      // - Env var access (BACKEND_PORT via local const above)
      // - Any references to process.env removed
      // - No CommonJS exports at the end

      handleNewMessage(message: any) {
        this.messages.push(message);
        const messagesContainer = document.getElementById('chatMessages');
        if (messagesContainer) {
          messagesContainer.innerHTML = this.renderMessages();
          this.scrollToBottom();
        }
      }

      handleHistoryLoaded(messages: any[]) {
        this.messages = messages;
        const messagesContainer = document.getElementById('chatMessages');
        if (messagesContainer) {
          messagesContainer.innerHTML = this.renderMessages();
          this.scrollToBottom();
        }
      }

      handleConnectionStatusChange(connected: boolean) {
        const input = document.getElementById('messageInput') as HTMLInputElement | null;
        const sendButton = document.getElementById('sendMessage') as HTMLButtonElement | null;
        if (input) {
          input.placeholder = connected ? 'Type your message...' : 'Waku not connected. Messages may not send.';
        }
        if (sendButton) sendButton.disabled = !connected;
      }

      detectMarketInfo() {
        console.log('Detecting market info...');
        if ((window as any).CHAT_PAIR_OVERRIDE) {
          this.currentPair = (window as any).CHAT_PAIR_OVERRIDE;
          this.currentMarket = (window as any).CHAT_MARKET_OVERRIDE || 'Perps';
          return;
        }
        let pairElement: any = null;
        let newPair = '';
        pairElement = document.querySelector(
          '#coinInfo > div > div:nth-child(2) > div:nth-child(1) > div > div > div > div:nth-child(2) > div',
        );
        if (!pairElement || !pairElement.textContent.trim()) {
          pairElement = document.querySelector(
            '#root > div:nth-child(2) > div:nth-child(3) > div > div:nth-child(1) > div:nth-child(1) > div > div:nth-child(1) > div > div > div > div:nth-child(2) > div',
          );
        }
        if (!pairElement || !pairElement.textContent.trim()) {
          const coinIcon = document.querySelector('img[alt][src*="/coins/"]');
          if (coinIcon) {
            let container = (coinIcon as HTMLElement).closest('div[style*="display"]');
            if (container && (container as HTMLElement).parentElement) {
              const textElements = (container as HTMLElement).parentElement!.querySelectorAll('div');
              for (const el of textElements) {
                const text = (el as HTMLElement).textContent!.trim();
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
          newPair = (pairElement as HTMLElement).textContent!.trim();
          if (newPair.includes('Welcome')) {
            const match = newPair.match(/([A-Z]+[-]USD[C]?)/);
            if (match) newPair = match[1];
          }
          if (newPair && newPair !== this.currentPair) this.currentPair = newPair;
        }
        const spotElement = document.querySelector(
          'div[style*="background: rgb(7, 39, 35)"] .sc-bjfHbI.jxtURp.body12Regular',
        );
        const newMarket = spotElement && spotElement.textContent!.includes('Spot') ? 'Spot' : 'Perps';
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

      enableDrag(widget: HTMLElement, handleEl: Element | null) {
        const dragHandle = handleEl as HTMLElement | null;
        if (!dragHandle) return;
        let startX: number, startY: number, startLeft: number, startTop: number, isDragging = false;
        dragHandle.style.cursor = 'move';
        const onMouseMove = (e: MouseEvent) => {
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
          startX = (e as MouseEvent).clientX;
          startY = (e as MouseEvent).clientY;
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
            ${(window as any).IS_STANDALONE_CHAT ? `<button class="hl-chat-popin" id="popInChat" title="Return to page">⇦</button>` : `<button class="hl-chat-popout" id="popOutChat" title="Open in new tab">↗</button>`}
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
            <input type="text" class="hl-chat-input" id="messageInput" placeholder="${this.jwtToken || this.wakuClient ? `Chat with ${roomId} traders...` : 'No connection available - read-only mode'}" maxlength="500" ${!this.jwtToken && !this.wakuClient ? 'disabled' : ''} />
            <button class="hl-send-btn" id="sendMessage" ${!this.jwtToken && !this.wakuClient ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>Send</button>
          </div>
          `}
        </div>
        <div class="hl-chat-toggle" id="chatToggle"><span>💬</span></div>
      </div>`;
      }

      renderMessages() {
        if (this.messages.length === 0) return '';
        return this.messages
          .map((msg: any) => {
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
          })
          .join('');
      }

      setupEventListeners() {
        const chatToggle = document.getElementById('chatToggle');
        if (chatToggle) chatToggle.addEventListener('click', () => this.toggleChat());
        const closeChat = document.getElementById('closeChat');
        if (closeChat) closeChat.addEventListener('click', () => this.hideChat());
        const connectWallet = document.getElementById('connectWallet');
        if (connectWallet) connectWallet.addEventListener('click', () => this.connectWallet());
        const sendMessage = document.getElementById('sendMessage');
        if (sendMessage) sendMessage.addEventListener('click', async () => { await this.sendMessage(); });
        const messageInput = document.getElementById('messageInput');
        if (messageInput) messageInput.addEventListener('keypress', async (e: any) => { if (e.key === 'Enter') await this.sendMessage(); });
        const autoScrollCheckbox = document.getElementById('autoScrollCheckbox') as HTMLInputElement | null;
        if (autoScrollCheckbox) autoScrollCheckbox.addEventListener('change', (e: any) => { this.autoScroll = e.target.checked; if (this.autoScroll) this.scrollToBottom(); });
        const nameSelect = document.getElementById('hlNameSelect') as HTMLSelectElement | null;
        if (nameSelect) nameSelect.addEventListener('change', (e: any) => { this.selectedName = e.target.value; });
        if (!(window as any).IS_STANDALONE_CHAT) {
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

      async connectWallet() {
        // Same logic from original content.js, elided for brevity
        try {
          const accounts = await new Promise<string[]>((resolve, reject) => {
            const id = Date.now() + Math.random();
            const handler = (event: any) => {
              if (event.source !== window || !event.data || event.data.type !== 'HL_CONNECT_WALLET_RESPONSE' || event.data.id !== id) return;
              window.removeEventListener('message', handler as any);
              if (event.data.error) reject(new Error(event.data.error));
              else resolve(event.data.accounts as string[]);
            };
            window.addEventListener('message', handler as any);
            window.postMessage({ type: 'HL_CONNECT_WALLET_REQUEST', id }, '*');
          });
          if (accounts && accounts.length > 0) {
            this.walletAddress = accounts[0];
            // Fetch HL names (no change)
            this.availableNames = await this.fetchHLNames(this.walletAddress);
            this.selectedName = this.availableNames[0] || '';
            await this.handleBackendAuth();
            chrome.storage.local.set({ walletConnected: true, walletAddress: this.walletAddress, availableNames: this.availableNames, selectedName: this.selectedName, hasBackendAuth: !!this.jwtToken }).catch(() => {});
            chrome.runtime.sendMessage({ action: 'walletConnected', walletAddress: this.walletAddress, availableNames: this.availableNames, selectedName: this.selectedName, hasBackendAuth: !!this.jwtToken }).catch(() => {});
            await this.loadChatHistoryWithRetry();
            this.subscribeBroadcast();
          }
        } catch (error: any) {
          console.error('Failed to connect wallet:', error);
          alert(error?.message || 'Failed to connect wallet. Please try again.');
        }
      }

      async handleBackendAuth() {
        const ts = Date.now();
        const loginMsg = `HyperLiquidChat login ${ts}`;
        const signature = await this.signMessage(loginMsg);
        const resp = await fetch(`http://localhost:${BACKEND_PORT}/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: this.walletAddress, signature, timestamp: ts })
        });
        if (!resp.ok) throw new Error('Authentication failed');
        const data = await resp.json();
        this.jwtToken = data.token;
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

      subscribeBroadcast() { this.subscribeToMessages(); }
      async subscribeToMessages() {
        if (!this.wakuClient) return;
        this.wakuClient.setRoom(this.currentPair, this.currentMarket);
        try { await this.wakuClient.subscribe(); } catch (e) { console.error('Failed to subscribe to Waku messages:', e); }
      }

      async sendMessage() {
        if (this.wakuClient) return this.sendMessageViaWaku();
        // Legacy flow omitted in WXT build
      }

      async sendMessageViaWaku() {
        const input = document.getElementById('messageInput') as HTMLInputElement | null;
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
          console.error('Failed to send message via Waku:', error);
          alert('Failed to send message. Please try again.');
        }
      }

      updateChatHeader() {
        const pairElement = document.querySelector('.hl-chat-pair');
        const marketElement = document.querySelector('.hl-chat-market');
        const inputElement = document.getElementById('messageInput') as HTMLInputElement | null;
        if (pairElement) (pairElement as HTMLElement).textContent = this.currentPair;
        if (marketElement) (marketElement as HTMLElement).textContent = `${this.currentMarket} Chat`;
        const roomId = `${this.currentPair}_${this.currentMarket}`;
        if (inputElement) inputElement.placeholder = this.wakuClient ? `Chat with ${roomId} traders...` : `Chat with ${roomId} traders... (Waku not connected)`;
      }

      setupMessageListener() {
    browser.runtime.onMessage.addListener(async (request: any) => {
          if (request.action === 'toggleChat') this.showChat();
          else if (request.action === 'showChat' && !(window as any).IS_STANDALONE_CHAT) {
            this.currentPair = request.pair || this.currentPair;
            this.currentMarket = request.market || this.currentMarket;
            this.showChatDirect();
          } else if (request.action === 'hideChat' && !(window as any).IS_STANDALONE_CHAT) this.hideChat();
          else if (request.action === 'getCurrentRoom') {
            return { pair: this.currentPair, market: this.currentMarket, messages: this.messages, walletAddress: this.walletAddress, availableNames: this.availableNames, selectedName: this.selectedName };
          } else if (request.action === 'requestWalletConnection') this.connectWallet();
          else if (request.action === 'sendMessage') {
            if (this.walletAddress) {
              this.selectedName = request.selectedName || this.selectedName;
              const messageInput = document.getElementById('messageInput') as HTMLInputElement | null;
              if (messageInput) { messageInput.value = request.content; this.sendMessage(); }
            }
          } else if (request.action === 'signMessage') {
            if (this.walletAddress) {
              try { const signature = await this.signMessage(request.message); return { signature }; } catch (error: any) { return { error: error.message }; }
            } else return { error: 'Wallet not connected' };
          } else if (request.action === 'roomChange' && (window as any).IS_STANDALONE_CHAT) {
            const { pair, market } = request; if (!pair || !market) return;
            const oldRoom = `${this.currentPair}_${this.currentMarket}`; const newRoom = `${pair}_${market}`;
            if (oldRoom === newRoom) return;
            this.currentPair = pair; this.currentMarket = market; (window as any).CHAT_PAIR_OVERRIDE = pair; (window as any).CHAT_MARKET_OVERRIDE = market;
            this.messages = []; this.updateChatHeader();
            const messagesContainer = document.getElementById('chatMessages');
            if (messagesContainer) messagesContainer.innerHTML = '<div class="hl-loading">Loading…</div>';
            await this.loadChatHistoryWithRetry(); await this.subscribeBroadcast();
          } else if (request.action === 'syncMessages') {
            return { messages: this.messages, currentPair: this.currentPair, currentMarket: this.currentMarket };
          }
        });
      }

      formatAddress(address: string) { return `${address.slice(0, 6)}...${address.slice(-4)}`; }
      formatTime(timestamp: number) { return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
      escapeHtml(text: string) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
      scrollToBottom() { if (!this.autoScroll) return; const messagesContainer = document.getElementById('chatMessages'); if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight; }
      toggleChat() { this.isVisible = !this.isVisible; const container = document.querySelector('.hl-chat-container') as HTMLElement | null; if (container) { container.style.opacity = this.isVisible ? '1' : '0'; container.style.pointerEvents = this.isVisible ? 'auto' : 'none'; container.classList.toggle('visible', this.isVisible); } }
      showChat() { browser.storage.local.get(['chatMode']).then((result: any) => { const mode = result.chatMode || 'sidepanel'; if (mode === 'floating') this.showChatDirect(); }); }
      showChatDirect() { this.isVisible = true; let widget = document.getElementById('hyperliquid-chat-widget'); if (!widget) { this.createChatWidget(); widget = document.getElementById('hyperliquid-chat-widget'); } const container = widget?.querySelector('.hl-chat-container') as HTMLElement | null; if (container) container.classList.add('visible'); }
      hideChat() { this.isVisible = false; const widget = document.getElementById('hyperliquid-chat-widget'); if (widget) widget.remove(); }

      signMessage(message: string) {
        return new Promise<string>((resolve, reject) => {
          const id = Date.now() + Math.random();
          const handler = (event: any) => {
            if (event.source !== window || !event.data || event.data.type !== 'HL_SIGN_RESPONSE' || event.data.id !== id) return;
            window.removeEventListener('message', handler as any);
            if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.signature as string);
          };
          window.addEventListener('message', handler as any);
          window.postMessage({ type: 'HL_SIGN_REQUEST', id, message, address: this.walletAddress }, '*');
        });
      }

      async fetchHLNames(address: string) {
        try {
          const resp = await fetch(`https://api.hlnames.xyz/utils/names_owner/${address}`, { headers: { 'X-API-Key': 'CPEPKMI-HUSUX6I-SE2DHEA-YYWFG5Y' } });
          if (!resp.ok) return [];
          const data = await resp.json();
          if (!Array.isArray(data)) return [];
          return data.map((x: any) => x.name).filter(Boolean);
        } catch (err) {
          console.error('Error fetching HL names', err);
          return [];
        }
      }

      injectWalletBridge() {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('wallet-bridge.js');
        (document.head || document.documentElement).appendChild(script);
        script.onload = () => { script.remove(); };
      }

      startMarketMonitoring() {
        // Minimal polling to detect pair changes; re-using original behavior
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

      async restoreWalletConnection() {
        try {
          const data = await new Promise<any>((resolve) => chrome.storage.local.get(['walletConnected', 'walletAddress', 'availableNames', 'selectedName', 'hasBackendAuth'], (val: any) => resolve(val)));
          if (data.walletConnected && data.walletAddress) {
            this.walletAddress = data.walletAddress;
            this.availableNames = data.availableNames || [];
            this.selectedName = data.selectedName || '';
            if (data.hasBackendAuth) this.jwtToken = 'restored';
          }
        } catch {}
      }
    }

    // Initialize chat when page loads
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { initializeWaku(); });
    else initializeWaku();
    // END migrated content.js
  },
});
