// Migrated from sidepanel.js
import { browser } from 'wxt/browser';
import type { Message } from '../../src/messages';
console.log('Sidepanel script loaded');

// Get URL parameters for current trading pair/market
const params = new URLSearchParams(location.search);
const initialPair = params.get('pair') || 'UNKNOWN';
const initialMarket = params.get('market') || 'Perps';
const SIDEPANEL_SYNC_PORT = 'sidepanel-sync';

// State
let currentPair = initialPair;
let currentMarket = initialMarket;
let walletAddress = '';
let messages: any[] = [];
let wakuClient: any = null;
let availableNames: string[] = [];
let selectedName = '';
let autoScroll = true;
let hasBackendAuth = false;
let hasLoadedInitialData = false;

// Initialize Waku client
async function initializeWaku() {
  try {
    const env = (import.meta as any).env ?? {};
    const wakuModule: any = await import(chrome.runtime.getURL('lib/waku-chat-client.js'));
    wakuClient = new wakuModule.WakuChatClient({
      wakuNodeURI: env.VITE_WAKU_NODE_URI || 'localhost',
      wakuNodePort: typeof env.VITE_WAKU_NODE_PORT === 'string'
        ? parseInt(env.VITE_WAKU_NODE_PORT, 10)
        : (env.VITE_WAKU_NODE_PORT || 443),
      wakuNodePeerId: env.VITE_WAKU_NODE_PEER_ID || 'PEER_ID',
      gatewayUrl: env.VITE_LIGHTPUSH_GATEWAY_URL || '',
      onMessageReceived: (message: any) => { handleNewMessage(message); },
      onHistoryLoaded: (loadedMessages: any[]) => { handleHistoryLoaded(loadedMessages); },
      onConnectionStatusChange: (connected: boolean) => { handleConnectionStatusChange(connected); },
    });
    if (wakuClient?.setSiweSigner) {
      wakuClient.setSiweSigner(signMessageViaContent);
    }
    const success = await wakuClient.initialize();
    console.log(success ? 'Waku client initialized successfully' : 'Failed to initialize Waku client');
    return !!success;
  } catch (error) {
    console.error('Failed to initialize Waku:', error);
    return false;
  }
}

function handleNewMessage(message: any) { messages.push(message); updateMessagesUI(); scrollToBottom(); }
function handleHistoryLoaded(loadedMessages: any[]) { messages = loadedMessages; updateMessagesUI(); scrollToBottom(); }
function handleConnectionStatusChange(connected: boolean) {
  const input = document.getElementById('messageInput') as HTMLInputElement | null;
  const sendButton = document.getElementById('sendButton') as HTMLButtonElement | null;
  if (input) input.placeholder = connected ? 'Type your message...' : 'Waku not connected. Messages may not send.';
  if (sendButton) sendButton.disabled = !connected;
}

async function checkAndNavigateToTrade() {
  try {
    const [activeTab]: any = await browser.tabs.query({ active: true, currentWindow: true });
    if (activeTab && (!activeTab.url || !activeTab.url.includes('app.hyperliquid.xyz/trade'))) {
      await browser.tabs.update(activeTab.id!, { url: 'https://app.hyperliquid.xyz/trade' });
      await new Promise<void>((resolve) => {
        const listener = (tabId: any, info: any) => {
          if (tabId === activeTab.id && info.status === 'complete') {
            browser.tabs.onUpdated.removeListener(listener);
            setTimeout(resolve, 2000);
          }
        };
        browser.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 10000);
      });
    }
  } catch (error) { console.error('Error checking/navigating to trade page:', error); }
}

async function restoreWalletConnection() {
  try {
    const result: any = await browser.storage.local.get(['walletConnected','walletAddress','availableNames','selectedName','hasBackendAuth']);
    if (result.walletConnected && result.walletAddress) {
      walletAddress = result.walletAddress;
      availableNames = result.availableNames || [];
      selectedName = result.selectedName || '';
      hasBackendAuth = result.hasBackendAuth || false;
      // Sync wallet info to Waku client if available
      if (wakuClient) {
        wakuClient.setWalletInfo(walletAddress, selectedName);
      }
    }
  } catch (error) { console.error('Failed to restore wallet connection in side panel:', error); }
}

function applySyncSidepanel(request: Message) {
  if (request.action !== 'syncSidepanel') return;
  if (request.pair && request.pair !== 'UNKNOWN') {
    currentPair = request.pair;
    currentMarket = request.market || 'Perps';
    messages = request.messages || [];
    if (!hasLoadedInitialData) {
      hasLoadedInitialData = true;
      createChatUI();
      setupEventListeners();
      loadChatHistory();
      subscribeBroadcast();
    } else {
      updateChatHeader();
      updateMessagesUI();
      scrollToBottom();
      subscribeBroadcast();
    }
  }
}

async function initializeChat() {
  const root = document.getElementById('sidepanel-root')!;
  root.innerHTML = `
    <div style="padding: 20px; text-align: center;">
      <h3>Navigating to Hyperliquid...</h3>
      <p>Please wait while we load the trade page</p>
    </div>`;

  try { await Promise.race([checkAndNavigateToTrade(), new Promise((_ , reject) => setTimeout(() => reject(new Error('Navigation timeout')), 3000))]); }
  catch (e: any) { console.log('Navigation check failed or timed out, continuing anyway:', e.message); }

  await restoreWalletConnection();

  let syncAttempts = 0; const maxAttempts = 20;
  while (!hasLoadedInitialData && syncAttempts < maxAttempts) {
    await syncWithContentScript();
    if (!hasLoadedInitialData) { await new Promise((r) => setTimeout(r, 500)); syncAttempts++; }
  }
  if (!hasLoadedInitialData) {
    currentPair = 'HYPE-USD'; currentMarket = 'Perps'; hasLoadedInitialData = true; createChatUI(); setupEventListeners();
    if (wakuClient) { loadChatHistory(); subscribeBroadcast(); }
  }

  browser.runtime.onMessage.addListener((request: Message) => {
    if (request.action === 'roomChange') {
      currentPair = request.pair; currentMarket = request.market; updateChatHeader(); loadChatHistory(); subscribeBroadcast();
    } else if (request.action === 'closeSidePanel') {
      window.close();
    } else if (request.action === 'syncSidepanel') {
      applySyncSidepanel(request);
    }
  });

  setInterval(async () => {
    await syncWithContentScript();
    if (!document.querySelector('.hl-chat-widget') && hasLoadedInitialData) { createChatUI(); setupEventListeners(); loadChatHistory(); subscribeBroadcast(); }
  }, 1000);
}

async function syncWithContentScript() {
  try {
    const tabs: any[] = await browser.tabs.query({ url: '*://app.hyperliquid.xyz/trade*' });
    if (tabs && tabs.length > 0) {
      for (const tab of tabs as any[]) {
        try {
          const response: any = await browser.tabs.sendMessage(tab.id!, { action: 'getCurrentRoom' }).catch(() => undefined);
          if (response && response.pair && response.pair !== 'UNKNOWN') {
            currentPair = response.pair; currentMarket = response.market || 'Perps';
            if (response.messages) messages = response.messages;
            if (response.walletAddress) { walletAddress = response.walletAddress; availableNames = response.availableNames || []; selectedName = response.selectedName || ''; hasBackendAuth = true; }
            if (!hasLoadedInitialData) { await new Promise((r) => setTimeout(r, 2000)); hasLoadedInitialData = true; createChatUI(); setupEventListeners(); loadChatHistory(); subscribeBroadcast(); }
            else { updateChatHeader(); updateMessagesUI(); }
            return;
          }
        } catch (error: any) { console.log(`Could not sync with tab ${tab.id}:`, error.message); }
      }
    }
  } catch (error) { console.log('Error in syncWithContentScript:', error); }
}

function createChatUI() {
  const root = document.getElementById('sidepanel-root')!;
  const roomId = `${currentPair}_${currentMarket}`;
  const isConnected = !!walletAddress;
  root.innerHTML = `
    <div class="hl-chat-widget">
      <div class="hl-chat-container visible">
        <div class="hl-chat-header">
          <div class="hl-chat-title">
            <span class="hl-chat-pair">${currentPair}</span>
            <span class="hl-chat-market">${currentMarket ? currentMarket + ' Chat' : ''}</span>
          </div>
          <div class="hl-chat-autoscroll">
            <input type="checkbox" id="autoScrollCheckbox" ${autoScroll ? 'checked' : ''}>
            <label for="autoScrollCheckbox">Auto-scroll</label>
          </div>
          <div class="hl-chat-controls">
            <button class="hl-chat-popout" id="openFloatingChat" title="Open floating chat on page">↗</button>
            <button class="hl-sidepanel-close" id="closeSidePanel" title="Close side panel">×</button>
          </div>
        </div>
        <div class="hl-chat-content">
          <div class="hl-chat-messages" id="chatMessages">
            <div class="hl-loading">Loading ${roomId} chat...</div>
          </div>
          ${!isConnected ? `
          <div class="hl-chat-auth-bar" id="chatAuthBar">
            <div class="hl-auth-message">
              <span>Connect wallet via content script to send messages</span>
              <button class="hl-connect-btn-small" id="requestWalletConnection">Request Connection</button>
            </div>
          </div>` : `
          <div class="hl-name-bar">
            <label class="hl-name-label">As:</label>
            <select id="hlNameSelect" class="hl-name-select-input">
              <option value="" ${selectedName === '' ? 'selected' : ''}>${formatAddress(walletAddress)}</option>
              ${availableNames.map((n) => `<option value="${n}" ${n === selectedName ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </div>
          <div class="hl-chat-input-container">
            <input type="text" class="hl-chat-input" id="messageInput" placeholder="${hasBackendAuth ? `Chat with ${roomId} traders...` : 'Backend server not available - read-only mode'}" maxlength="500" ${!hasBackendAuth ? 'disabled' : ''} />
            <button class="hl-send-btn" id="sendMessage" ${!hasBackendAuth ? 'disabled style=\"opacity: 0.5; cursor: not-allowed;\"' : ''}>Send</button>
          </div>`}
        </div>
      </div>
    </div>`;
}

function setupEventListeners() {
  const closeBtn = document.getElementById('closeSidePanel');
  if (closeBtn) closeBtn.addEventListener('click', () => window.close());
  const openFloatingBtn = document.getElementById('openFloatingChat');
  if (openFloatingBtn) openFloatingBtn.addEventListener('click', async () => {
    try {
      const [tab]: any = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
        browser.tabs.sendMessage(tab.id!, { action: 'showChat', pair: currentPair, market: currentMarket });
      } else { alert('Please navigate to app.hyperliquid.xyz/trade to use floating chat'); }
    } catch (error) { console.error('Failed to open floating chat:', error); alert('Failed to open floating chat. Please try again.'); }
  });
  const autoScrollCheckbox = document.getElementById('autoScrollCheckbox') as HTMLInputElement | null;
  if (autoScrollCheckbox) autoScrollCheckbox.addEventListener('change', (e: any) => { autoScroll = (e.target as HTMLInputElement).checked; if (autoScroll) scrollToBottom(); });
  const requestConnectionBtn = document.getElementById('requestWalletConnection');
  if (requestConnectionBtn) requestConnectionBtn.addEventListener('click', async () => {
    try {
      const [tab]: any = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) browser.tabs.sendMessage(tab.id!, { action: 'requestWalletConnection' });
      else alert('Please navigate to app.hyperliquid.xyz/trade to connect your wallet');
    } catch (error) { console.error('Failed to request wallet connection:', error); alert('Failed to request wallet connection. Please try connecting directly on the page.'); }
  });
  const sendBtn = document.getElementById('sendMessage');
  if (sendBtn) sendBtn.addEventListener('click', sendMessage);
  const messageInput = document.getElementById('messageInput');
  if (messageInput) messageInput.addEventListener('keypress', (e: any) => { if (e.key === 'Enter') sendMessage(); });
  const nameSelect = document.getElementById('hlNameSelect') as HTMLSelectElement | null;
  if (nameSelect) nameSelect.addEventListener('change', (e: any) => {
    selectedName = e.target.value;
    // Sync updated name to Waku client
    if (wakuClient && walletAddress) {
      wakuClient.setWalletInfo(walletAddress, selectedName);
    }
  });
}

async function loadChatHistory() {
  if (!wakuClient) { updateMessagesUI('<div class="hl-error">Waku client not available</div>'); return; }
  try { wakuClient.setRoom(currentPair, currentMarket); await wakuClient.loadHistoryWithRetry(); }
  catch (error) { console.error('Failed to load history from Waku:', error); updateMessagesUI('<div class="hl-error">Failed to load chat history</div>'); }
}

function subscribeBroadcast() {
  if (!wakuClient) return;
  try { wakuClient.setRoom(currentPair, currentMarket); wakuClient.subscribe(); }
  catch (error) { console.error('Failed to subscribe to Waku messages:', error); }
}

async function sendMessage() {
  const input = document.getElementById('messageInput') as HTMLInputElement | null;
  const content = (input?.value || '').trim();
  if (!content) return;
  if (!walletAddress) { alert('Please connect your wallet first'); return; }
  if (wakuClient) {
    try {
      wakuClient.setRoom(currentPair, currentMarket);
      wakuClient.setWalletInfo(walletAddress, selectedName);
      const optimistic = await wakuClient.sendMessage(content);
      messages.push(optimistic);
      if (input) input.value = '';
      updateMessagesUI(); scrollToBottom();
    } catch (error) { console.error('Failed to send message:', error); alert('Failed to send message. Please try again.'); }
  }
}

async function signMessageViaContent(message: string) {
  const [tab]: any = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('app.hyperliquid.xyz')) {
    throw new Error('Please navigate to app.hyperliquid.xyz/trade to sign');
  }
  try {
    await browser.scripting.executeScript({ target: { tabId: tab.id! }, func: () => void 0 });
  } catch {}
  const signRes: any = await browser.tabs.sendMessage(tab.id!, { action: 'signMessage', message });
  if (signRes?.error) throw new Error(signRes.error);
  const signature = signRes?.signature || '';
  if (!signature) throw new Error('Signature missing');
  return signature;
}

function updateMessagesUI(customHTML: string | null = null) {
  const messagesContainer = document.getElementById('chatMessages')!;
  if (customHTML) { messagesContainer.innerHTML = customHTML; return; }
  if (messages.length === 0) { const roomId = `${currentPair}_${currentMarket}`; messagesContainer.innerHTML = `<div class=\"hl-loading\">No messages yet in ${roomId}. Be the first to chat!</div>`; return; }
  messagesContainer.innerHTML = messages.map((msg) => {
    const isOwn = msg.address === walletAddress;
    const displayName = msg.name || formatAddress(msg.address);
    return `
      <div class="hl-message ${isOwn ? 'own' : ''}">
        <div class="hl-message-header">
          <span class="hl-message-address">${displayName}</span>
          <span class="hl-message-time">${formatTime(msg.timestamp)}</span>
        </div>
        <div class="hl-message-content">${escapeHtml(msg.content)}</div>
      </div>`;
  }).join('');
}

function updateChatHeader() {
  const pairElement = document.querySelector('.hl-chat-pair');
  const marketElement = document.querySelector('.hl-chat-market');
  if (pairElement) (pairElement as HTMLElement).textContent = currentPair;
  if (marketElement) (marketElement as HTMLElement).textContent = currentMarket ? `${currentMarket} Chat` : '';
}

function formatAddress(address: string) { return `${address.slice(0, 6)}...${address.slice(-4)}`; }
function formatTime(timestamp: number) { return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function escapeHtml(text: string) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
function scrollToBottom() { if (!autoScroll) return; const messagesContainer = document.getElementById('chatMessages'); if (messagesContainer) (messagesContainer as HTMLElement).scrollTop = (messagesContainer as HTMLElement).scrollHeight; }

const syncSidepanelPort = browser.runtime.connect({ name: SIDEPANEL_SYNC_PORT });
syncSidepanelPort.onMessage.addListener((request: Message) => {
  applySyncSidepanel(request);
});

browser.runtime.onMessage.addListener((request: any, _sender: any, _sendResponse: any) => {
  if (request.action === 'walletConnected') {
    walletAddress = request.walletAddress;
    availableNames = request.availableNames || [];
    selectedName = request.selectedName || '';
    hasBackendAuth = request.hasBackendAuth || false;
    // Sync wallet info to Waku client
    if (wakuClient) {
      wakuClient.setWalletInfo(walletAddress, selectedName);
    }
    if (hasLoadedInitialData && currentPair !== 'UNKNOWN') {
      createChatUI();
      setupEventListeners();
      loadChatHistory();
    }
  } else if (request.action === 'walletDisconnected') {
    walletAddress = '';
    availableNames = [];
    selectedName = '';
    hasBackendAuth = false;
    // Clear wallet info from Waku client
    if (wakuClient) {
      wakuClient.setWalletInfo('', '');
    }
    browser.storage.local.remove(['walletConnected', 'walletAddress', 'availableNames', 'selectedName', 'hasBackendAuth']).catch(console.error);
    if (hasLoadedInitialData && currentPair !== 'UNKNOWN') {
      createChatUI();
      setupEventListeners();
      loadChatHistory();
    }
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { initializeWaku().then(() => initializeChat()); });
} else {
  initializeWaku().then(() => initializeChat());
}
