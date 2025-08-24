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
let wakuClient = null;
let chatInstance = null;
let availableNames = [];
let selectedName = '';
let autoScroll = true;
let realtimeChannel = null;
let hasBackendAuth = false;
let hasLoadedInitialData = false;

// Initialize Waku client
async function initializeWaku() {
    try {
        console.log('Importing WakuChatClient...');
        const wakuModule = await import(chrome.runtime.getURL('lib/waku-chat-client.js'));
        console.log('✅ WakuChatClient imported');

        // Create Waku client with configuration
        wakuClient = new wakuModule.WakuChatClient({
            wakuNodeURI: process.env.WAKU_NODE_URI,
            wakuNodePort: process.env.WAKU_NODE_PORT,
            wakuNodePeerId: process.env.WAKU_NODE_PEER_ID,
            onMessageReceived: (message) => {
                // Handle new messages from Waku
                handleNewMessage(message);
            },
            onHistoryLoaded: (loadedMessages) => {
                // Handle loaded history from Waku
                handleHistoryLoaded(loadedMessages);
            },
            onConnectionStatusChange: (connected) => {
                // Handle connection status changes
                handleConnectionStatusChange(connected);
            }
        });

        // Initialize the Waku client
        const success = await wakuClient.initialize();
        if (success) {
            console.log('✅ Waku client initialized successfully');
            return true;
        } else {
            console.error('❌ Failed to initialize Waku client');
            return false;
        }

    } catch (error) {
        console.error('❌ Failed to initialize Waku:', error);
        return false;
    }
}

// Handle new messages from Waku
function handleNewMessage(message) {
    messages.push(message);
    updateMessagesUI();
    scrollToBottom();
}

// Handle loaded history from Waku
function handleHistoryLoaded(loadedMessages) {
    messages = loadedMessages;
    updateMessagesUI();
    scrollToBottom();
}

// Handle connection status changes
function handleConnectionStatusChange(connected) {
    const input = document.getElementById("messageInput");
    const sendButton = document.getElementById("sendButton");
    
    if (input) {
        input.placeholder = connected ? 
            "Type your message..." : 
            "Waku not connected. Messages may not send.";
    }
    
    if (sendButton) {
        sendButton.disabled = !connected;
    }
}

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
    
    // Show initial loading screen
    const root = document.getElementById('sidepanel-root');
    if (root) {
        root.innerHTML = `
            <div style="padding: 20px; text-align: center;">
                <h3>Navigating to Hyperliquid...</h3>
                <p>Please wait while we load the trade page</p>
            </div>
        `;
    }

    // Check if we need to navigate to trade page (with timeout)
    try {
        await Promise.race([
            checkAndNavigateToTrade(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Navigation timeout')), 3000))
        ]);
    } catch (error) {
        console.log('Navigation check failed or timed out, continuing anyway:', error.message);
    }

    // Restore wallet connection state if it exists
    await restoreWalletConnection();

    // Keep trying to sync until we get valid data
    let syncAttempts = 0;
    const maxAttempts = 20; // Try for up to 10 seconds
    
    while (!hasLoadedInitialData && syncAttempts < maxAttempts) {
        await syncWithContentScript();
        
        if (!hasLoadedInitialData) {
            // Wait 500ms before trying again
            await new Promise(resolve => setTimeout(resolve, 500));
            syncAttempts++;
        }
    }
    
    // If we still don't have data after all attempts, use defaults and create UI anyway
    if (!hasLoadedInitialData) {
        console.log('Could not sync with content script, using defaults');
        currentPair = 'HYPE-USD';
        currentMarket = 'Perps';
        hasLoadedInitialData = true;
        
        // Create UI with defaults
        createChatUI();
        setupEventListeners();
        
        // Try to load history if Waku is available
        if (wakuClient) {
            loadChatHistory();
            subscribeBroadcast();
        }
    }

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
                
                // If UI hasn't been created yet, create it now
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
                    
                    // Re-subscribe to the new room
                    if (realtimeChannel) {
                        supabase.removeChannel(realtimeChannel);
                    }
                    subscribeBroadcast();
                }
            }
        }
    });
    
    // Periodically sync with content script to stay up to date
    setInterval(async () => {
        await syncWithContentScript();
        
        // If we haven't created the UI yet and now have data, create it
        if (!document.querySelector('.hl-chat-widget') && hasLoadedInitialData) {
            createChatUI();
            setupEventListeners();
            loadChatHistory();
            subscribeBroadcast();
        }
    }, 1000); // Check every second
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
                        
                        // If this is first load, add a delay before creating UI
                        if (!hasLoadedInitialData) {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            hasLoadedInitialData = true;
                            
                            // Now create the UI since we have data
                            createChatUI();
                            setupEventListeners();
                            loadChatHistory();
                            subscribeBroadcast();
                        } else {
                            // Already loaded, just update UI
                            updateChatHeader();
                            updateMessagesUI();
                        }
                        
                        // Successfully synced, no need to check other tabs
                        return;
                    }
                } catch (error) {
                    console.log(`Could not sync with tab ${tab.id}:`, error.message);
                }
            }
        }
        
        // If we couldn't sync from any tab, keep showing "Waiting for Hyperliquid..."
        // Don't update currentPair/currentMarket to avoid showing UNKNOWN
        console.log('Waiting for Hyperliquid page to load...');
        
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
                        <span class="hl-chat-market">${currentMarket ? currentMarket + ' Chat' : ''}</span>
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
    // Use Waku if available, otherwise fall back to Supabase
    if (wakuClient) {
        try {
            // Set the current room in the Waku client
            wakuClient.setRoom(currentPair, currentMarket);
            await wakuClient.loadHistoryWithRetry();
            return;
        } catch (error) {
            console.error('Failed to load history from Waku:', error);
        }
    }
    
    // Legacy Supabase fallback
    if (!supabase) {
        console.warn('Neither Waku nor Supabase available for history loading');
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
    // Use Waku if available, otherwise fall back to Supabase
    if (wakuClient) {
        try {
            // Set the current room in the Waku client
            wakuClient.setRoom(currentPair, currentMarket);
            wakuClient.subscribe();
            return;
        } catch (error) {
            console.error('Failed to subscribe to Waku messages:', error);
        }
    }
    
    // Legacy Supabase fallback
    if (!supabase) {
        console.warn('Neither Waku nor Supabase available for subscription');
        return;
    }

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

    // Use Waku if available, otherwise fall back to content script delegation
    if (wakuClient) {
        try {
            // Set wallet info in Waku client
            wakuClient.setWalletInfo(walletAddress, selectedName);
            
            // Get signature from content script
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.url || !tab.url.includes('app.hyperliquid.xyz')) {
                alert('Please navigate to app.hyperliquid.xyz/trade to send messages');
                return;
            }

            const timestamp = Date.now();
            const dataToSign = JSON.stringify({ timestamp, content });
            
            // First, ensure content script is injected
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js']
                });
                // Wait a bit for content script to initialize
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (e) {
                console.log('Content script may already be injected');
            }
            
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: 'signMessage',
                message: dataToSign
            });

            if (!response || !response.signature) {
                throw new Error('Failed to get signature');
            }

            // Optimistic UI
            const optimisticMessage = {
                address: walletAddress,
                name: selectedName,
                content,
                timestamp,
                signature: response.signature,
                isOptimistic: true
            };
            messages.push(optimisticMessage);
            updateMessagesUI();
            scrollToBottom();
            input.value = '';

            // Send via Waku client
            await wakuClient.sendMessage(content, response.signature);
            
            // Remove optimistic flag after successful send
            const sentMsg = messages.find(m => m.isOptimistic && m.timestamp === timestamp);
            if (sentMsg) {
                delete sentMsg.isOptimistic;
            }

            return;
        } catch (error) {
            console.error('Failed to send message via Waku:', error);
            // Remove optimistic message on error
            messages = messages.filter(msg => !msg.isOptimistic);
            updateMessagesUI();
            scrollToBottom();
            alert(`Failed to send message: ${error.message}`);
            return;
        }
    }
    
    // Legacy method - delegate to content script
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
    if (marketElement) marketElement.textContent = currentMarket ? `${currentMarket} Chat` : '';
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
        
        // Only recreate UI if we have valid pair data
        if (hasLoadedInitialData && currentPair !== 'UNKNOWN') {
            createChatUI(); // Recreate UI with connected state
            setupEventListeners();
            // Reload messages after UI recreation
            loadChatHistory();
        }
    } else if (request.action === 'walletDisconnected') {
        walletAddress = '';
        availableNames = [];
        selectedName = '';
        hasBackendAuth = false;

        // Clear stored wallet state
        chrome.storage.local.remove(['walletConnected', 'walletAddress', 'availableNames', 'selectedName', 'hasBackendAuth']).catch(console.error);

        // Only recreate UI if we have valid pair data
        if (hasLoadedInitialData && currentPair !== 'UNKNOWN') {
            createChatUI(); // Recreate UI with disconnected state
            setupEventListeners();
            // Reload messages after UI recreation
            loadChatHistory();
        }
    }
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('TRACE: DOMContentLoaded event fired.');
        // Initialize Waku as primary, Supabase as fallback
        //initializeWaku();
        console.log('TRACE: initializeWaku() has been called...');
        // Only initialize Supabase if explicitly needed (for backward compatibility)
        // initializeSupabase();
        initializeWaku().then(success => {
            // Initialize chat regardless of Waku success (can fall back to Supabase)
            initializeChat();
            console.log('TRACE: initializeChat() has been called, Waku success:', success);
        });
    });
} else {
    // Initialize Waku as primary, Supabase as fallback
    //initializeWaku();
    // Only initialize Supabase if explicitly needed (for backward compatibility)
    // initializeSupabase();
    initializeWaku().then(success => {
        if (success) {
            initializeChat();
            console.log('TRACE: initializeChat() has been called, now proceeding.');
        }
    });
}
