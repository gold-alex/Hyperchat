// Side panel script for Hyperliquid Chat
// This runs in the extension context, not the page context

console.log('Sidepanel script loaded');

// Get URL parameters for current trading pair/market
const params = new URLSearchParams(location.search);
const initialPair = params.get('pair') || 'UNKNOWN';
const initialMarket = params.get('market') || 'Perps';

// State management
let currentPair = initialPair;
let currentMarket = initialMarket;
let walletAddress = '';
let messages = [];
let supabase = null;
let chatInstance = null;
let availableNames = [];
let selectedName = '';
let autoScroll = true;
let realtimeChannel = null;
let hasBackendAuth = false;

// Initialize Supabase
async function initializeSupabase() {
    console.log('Importing Supabase library...');

    try {
        const supabaseModule = await import(chrome.runtime.getURL('supabase.js'));
        console.log('✅ Supabase module imported');

        let createClient = null;
        if (supabaseModule?.supabase?.createClient) {
            createClient = supabaseModule.supabase.createClient;
        } else if (supabaseModule?.createClient) {
            createClient = supabaseModule.createClient;
        } else if (typeof window !== 'undefined' && window.supabase?.createClient) {
            createClient = window.supabase.createClient;
        }

        if (createClient) {
            const SUPABASE_URL = process.env.SUPABASE_URL;
            const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
            supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            console.log('✅ Supabase client created successfully');
        } else {
            console.error('❌ Could not locate createClient after importing Supabase');
        }
    } catch (error) {
        console.error('❌ Failed to import Supabase library:', error);
    }

    initializeChat();
}

// Check if we're on trade page and navigate if not
async function checkAndNavigateToTrade() {
    try {
        // Get the current active tab
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (activeTab && (!activeTab.url || !activeTab.url.includes('app.hyperliquid.xyz/trade'))) {
            console.log('Not on trade page, navigating...');
            
            // Show a loading message while navigating
            const root = document.getElementById('sidepanel-root');
            if (root) {
                root.innerHTML = `
                    <div style="padding: 20px; text-align: center;">
                        <h3>Navigating to Hyperliquid...</h3>
                        <p>Please wait while we load the trade page</p>
                    </div>
                `;
            }
            
            // Navigate to trade page
            await chrome.tabs.update(activeTab.id, { url: 'https://app.hyperliquid.xyz/trade' });
            
            // Wait for the page to load
            await new Promise((resolve) => {
                const listener = (tabId, info) => {
                    if (tabId === activeTab.id && info.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(listener);
                        // Add extra delay for content script to initialize
                        setTimeout(resolve, 2000);
                    }
                };
                chrome.tabs.onUpdated.addListener(listener);
                
                // Timeout after 10 seconds
                setTimeout(resolve, 10000);
            });
            
            console.log('Navigation complete');
        } else {
            console.log('Already on trade page');
        }
    } catch (error) {
        console.error('Error checking/navigating to trade page:', error);
    }
}

// Restore wallet connection state from Chrome storage
async function restoreWalletConnection() {
    try {
        console.log("Checking for stored wallet connection in side panel...");

        const result = await new Promise((resolve) => {
            chrome.storage.local.get(['walletConnected', 'walletAddress', 'availableNames', 'selectedName', 'hasBackendAuth'], (data) => {
                resolve(data);
            });
        });

        if (result.walletConnected && result.walletAddress) {
            console.log("Restoring wallet connection in side panel:", result.walletAddress);

            // Restore wallet state
            walletAddress = result.walletAddress;
            availableNames = result.availableNames || [];
            selectedName = result.selectedName || '';
            hasBackendAuth = result.hasBackendAuth || false;

            console.log("Wallet connection restored in side panel successfully");
        } else {
            console.log("No stored wallet connection found in side panel");
        }
    } catch (error) {
        console.error("Failed to restore wallet connection in side panel:", error);
    }
}

// Initialize chat UI
async function initializeChat() {
    console.log('Initializing side panel chat...');

    // Check if we need to navigate to trade page
    await checkAndNavigateToTrade();

    // Restore wallet connection state if it exists
    await restoreWalletConnection();

    // Try to sync with content script first
    await syncWithContentScript();

    createChatUI();
    setupEventListeners();
    
    // Only load from database if we didn't get messages from content script
    if (messages.length === 0) {
        loadChatHistory();
    } else {
        updateMessagesUI();
        scrollToBottom();
    }
    
    subscribeBroadcast();

    // Listen for room changes from content script and mode changes
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'roomChange') {
            currentPair = request.pair;
            currentMarket = request.market;
            updateChatHeader();
            loadChatHistory();
            if (realtimeChannel) {
                supabase.removeChannel(realtimeChannel);
            }
            subscribeBroadcast();
        } else if (request.action === 'closeSidePanel') {
            // Close the side panel when switching to floating mode
            window.close();
        } else if (request.action === 'syncSidepanel') {
            // Receive sync data from content script
            if (request.pair && request.pair !== 'UNKNOWN') {
                currentPair = request.pair;
                currentMarket = request.market || 'Perps';
                messages = request.messages || [];
                updateChatHeader();
                updateMessagesUI();
                scrollToBottom();
                
                // Re-subscribe to the new room
                if (realtimeChannel) {
                    supabase.removeChannel(realtimeChannel);
                }
                subscribeBroadcast();
            }
        }
    });
    
    // Periodically sync with content script to stay up to date
    setInterval(async () => {
        await syncWithContentScript();
    }, 5000); // Sync every 5 seconds
}

// Sync with content script to get current state
async function syncWithContentScript() {
    try {
        // Try to get the tab that has Hyperliquid open
        const tabs = await chrome.tabs.query({ url: "*://app.hyperliquid.xyz/trade*" });
        
        if (tabs && tabs.length > 0) {
            // Try each tab until we get a response
            for (const tab of tabs) {
                try {
                    const response = await new Promise((resolve, reject) => {
                        chrome.tabs.sendMessage(tab.id, { action: 'getCurrentRoom' }, (response) => {
                            if (chrome.runtime.lastError) {
                                reject(chrome.runtime.lastError);
                            } else {
                                resolve(response);
                            }
                        });
                    });
                    
                    if (response && response.pair && response.pair !== 'UNKNOWN') {
                        // Update our state with content script's data
                        currentPair = response.pair;
                        currentMarket = response.market || 'Perps';
                        
                        if (response.messages) {
                            messages = response.messages;
                        }
                        
                        if (response.walletAddress) {
                            walletAddress = response.walletAddress;
                            availableNames = response.availableNames || [];
                            selectedName = response.selectedName || '';
                            hasBackendAuth = true;
                        }
                        
                        console.log('✅ Synced with content script from tab:', {
                            tabId: tab.id,
                            pair: currentPair,
                            market: currentMarket,
                            messageCount: messages.length,
                            walletConnected: !!walletAddress
                        });
                        
                        // Successfully synced, no need to check other tabs
                        return;
                    }
                } catch (error) {
                    console.log(`Could not sync with tab ${tab.id}:`, error.message);
                }
            }
        }
        
        // If we couldn't sync from any tab, use URL params as fallback
        console.log('Using URL params as fallback:', { 
            pair: initialPair, 
            market: initialMarket 
        });
        
    } catch (error) {
        console.log('Error in syncWithContentScript:', error);
    }
}

// Create chat UI
function createChatUI() {
    const root = document.getElementById('sidepanel-root');
    const roomId = `${currentPair}_${currentMarket}`;
    const isConnected = !!walletAddress;

    root.innerHTML = `
        <div class="hl-chat-widget">
            <div class="hl-chat-container visible">
                <div class="hl-chat-header">
                    <div class="hl-chat-title">
                        <span class="hl-chat-pair">${currentPair}</span>
                        <span class="hl-chat-market">${currentMarket} Chat</span>
                    </div>
                    <div class="hl-chat-autoscroll">
                        <input type="checkbox" id="autoScrollCheckbox" ${autoScroll ? "checked" : ""}>
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
                    </div>
                    ` : `
                    <div class="hl-name-bar">
                        <label class="hl-name-label">As:</label>
                        <select id="hlNameSelect" class="hl-name-select-input">
                            <option value="" ${selectedName === '' ? 'selected' : ''}>${formatAddress(walletAddress)}</option>
                            ${availableNames.map(n => `<option value="${n}" ${n === selectedName ? 'selected' : ''}>${n}</option>`).join('')}
                        </select>
                    </div>
                    <div class="hl-chat-input-container">
                        <input 
                            type="text" 
                            class="hl-chat-input" 
                            id="messageInput" 
                            placeholder="${hasBackendAuth ? `Chat with ${roomId} traders...` : 'Backend server not available - read-only mode'}"
                            maxlength="500"
                            ${!hasBackendAuth ? 'disabled' : ''}
                        />
                        <button class="hl-send-btn" id="sendMessage" ${!hasBackendAuth ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>Send</button>
                    </div>
                    `}
                </div>
            </div>
        </div>
    `;
}

// Setup event listeners
function setupEventListeners() {
    // Close side panel
    const closeBtn = document.getElementById('closeSidePanel');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            window.close();
        });
    }

    // Open floating chat on page
    const openFloatingBtn = document.getElementById('openFloatingChat');
    if (openFloatingBtn) {
        openFloatingBtn.addEventListener('click', async () => {
            try {
                // Get the active tab
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
                    // Send message to content script to show floating chat
                    chrome.tabs.sendMessage(tab.id, { 
                        action: 'showChat',
                        pair: currentPair,
                        market: currentMarket
                    });
                } else {
                    alert('Please navigate to app.hyperliquid.xyz/trade to use floating chat');
                }
            } catch (error) {
                console.error('Failed to open floating chat:', error);
                alert('Failed to open floating chat. Please try again.');
            }
        });
    }

    // Auto-scroll toggle
    const autoScrollCheckbox = document.getElementById('autoScrollCheckbox');
    if (autoScrollCheckbox) {
        autoScrollCheckbox.addEventListener('change', (e) => {
            autoScroll = e.target.checked;
            if (autoScroll) {
                scrollToBottom();
            }
        });
    }

    // Request wallet connection (communicate with content script)
    const requestConnectionBtn = document.getElementById('requestWalletConnection');
    if (requestConnectionBtn) {
        requestConnectionBtn.addEventListener('click', async () => {
            try {
                // Get the active tab
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
                    // Send message to content script to trigger wallet connection
                    chrome.tabs.sendMessage(tab.id, { action: 'requestWalletConnection' });
                } else {
                    alert('Please navigate to app.hyperliquid.xyz/trade to connect your wallet');
                }
            } catch (error) {
                console.error('Failed to request wallet connection:', error);
                alert('Failed to request wallet connection. Please try connecting directly on the page.');
            }
        });
    }

    // Send message
    const sendBtn = document.getElementById('sendMessage');
    if (sendBtn) {
        sendBtn.addEventListener('click', sendMessage);
    }

    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });
    }

    // Name select
    const nameSelect = document.getElementById('hlNameSelect');
    if (nameSelect) {
        nameSelect.addEventListener('change', (e) => {
            selectedName = e.target.value;
        });
    }
}

// Load chat history
async function loadChatHistory() {
    if (!supabase) {
        console.warn('Supabase not initialized');
        return;
    }

    const roomId = `${currentPair}_${currentMarket}`;
    console.log(`Loading chat history for room: ${roomId}`);

    try {
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .eq('room', roomId)
            .order('timestamp', { ascending: true });

        if (error) {
            console.error('Error loading chat history:', error);
            updateMessagesUI('<div class="hl-error">Failed to load chat history</div>');
            return;
        }

        messages = data || [];
        updateMessagesUI();
        scrollToBottom();

    } catch (error) {
        updateMessagesUI('<div class="hl-error">Failed to load chat history</div>');
    }
}

// Subscribe to real-time updates
function subscribeBroadcast() {
    if (!supabase) return;

    const roomId = `${currentPair}_${currentMarket}`;
    console.log(`Subscribing to broadcast for room: ${roomId}`);

    const channel = supabase.channel(`room_${roomId}`, {
        config: { broadcast: { ack: true } },
    })
    .on('broadcast', { event: 'new-message' }, (payload) => {
        console.log('Received broadcast message:', payload);
        const msg = payload.payload;

        if (msg.room === roomId && msg.address !== walletAddress) {
            messages.push(msg);
            updateMessagesUI();
            scrollToBottom();
        }
    })
    .subscribe((status) => {
        console.log(`Broadcast subscription status for ${roomId}:`, status);
    });

    realtimeChannel = channel;
}

// Send message (delegate to content script)
async function sendMessage() {
    const input = document.getElementById('messageInput');
    const content = input.value.trim();

    if (!content) return;

    if (!walletAddress) {
        alert('Please connect your wallet first');
        return;
    }

    if (!hasBackendAuth) {
        alert('Backend server not available. Messages cannot be sent at this time.');
        return;
    }

    try {
        // Get the active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
            // Send message to content script to handle message sending
            chrome.tabs.sendMessage(tab.id, {
                action: 'sendMessage',
                content: content,
                selectedName: selectedName
            });

            input.value = '';

            // Optimistic UI update
            const optimisticMessage = {
                address: walletAddress,
                name: selectedName,
                content: content,
                timestamp: Date.now(),
                room: `${currentPair}_${currentMarket}`
            };

            messages.push(optimisticMessage);
            updateMessagesUI();
            scrollToBottom();

        } else {
            alert('Please navigate to app.hyperliquid.xyz/trade to send messages');
        }
    } catch (error) {
        console.error('Failed to send message:', error);
        alert('Failed to send message. Please try again.');
    }
}

// Update messages UI
function updateMessagesUI(customHTML = null) {
    const messagesContainer = document.getElementById('chatMessages');

    if (customHTML) {
        messagesContainer.innerHTML = customHTML;
        return;
    }

    if (messages.length === 0) {
        const roomId = `${currentPair}_${currentMarket}`;
        messagesContainer.innerHTML = `<div class="hl-loading">No messages yet in ${roomId}. Be the first to chat!</div>`;
        return;
    }

    const messagesHTML = messages.map(msg => {
        const isOwn = msg.address === walletAddress;
        const displayName = msg.name || formatAddress(msg.address);
        return `
            <div class="hl-message ${isOwn ? 'own' : ''}">
                <div class="hl-message-header">
                    <span class="hl-message-address">${displayName}</span>
                    <span class="hl-message-time">${formatTime(msg.timestamp)}</span>
                </div>
                <div class="hl-message-content">${escapeHtml(msg.content)}</div>
            </div>
        `;
    }).join('');

    messagesContainer.innerHTML = messagesHTML;
}

// Update chat header
function updateChatHeader() {
    const pairElement = document.querySelector('.hl-chat-pair');
    const marketElement = document.querySelector('.hl-chat-market');

    if (pairElement) pairElement.textContent = currentPair;
    if (marketElement) marketElement.textContent = `${currentMarket} Chat`;
}

// Utility functions
function formatAddress(address) {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function scrollToBottom() {
    if (!autoScroll) return;
    const messagesContainer = document.getElementById('chatMessages');
    if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
}

// Listen for wallet connection updates from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'walletConnected') {
        walletAddress = request.walletAddress;
        availableNames = request.availableNames || [];
        selectedName = request.selectedName || '';
        hasBackendAuth = request.hasBackendAuth || false;
        createChatUI(); // Recreate UI with connected state
        setupEventListeners();
        // Reload messages after UI recreation
        loadChatHistory();
    } else if (request.action === 'walletDisconnected') {
        walletAddress = '';
        availableNames = [];
        selectedName = '';
        hasBackendAuth = false;

        // Clear stored wallet state
        chrome.storage.local.remove(['walletConnected', 'walletAddress', 'availableNames', 'selectedName', 'hasBackendAuth']).catch(console.error);

        createChatUI(); // Recreate UI with disconnected state
        setupEventListeners();
        // Reload messages after UI recreation
        loadChatHistory();
    }
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeSupabase);
} else {
    initializeSupabase();
}
