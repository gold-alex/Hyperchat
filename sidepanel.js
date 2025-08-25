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
let hasLoadedInitialData = false;
let pnlService = null;
let userPnLCache = new Map();
let pnlUpdateInterval = null;

// Initialize Supabase
async function initializeSupabase() {
    console.log('Importing Supabase library...');

    try {
        // Import PnL service first
        await import(chrome.runtime.getURL('pnl-service.js'));
        if (typeof window.PnLService !== 'undefined') {
            pnlService = new window.PnLService();
            console.log('✅ P&L service initialized');
        }

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

    // Check if we need to navigate to trade page
    await checkAndNavigateToTrade();

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
    
    // If we still don't have data after all attempts, use defaults but don't show UNKNOWN
    if (!hasLoadedInitialData) {
        console.log('Could not sync with content script, waiting for data...');
        // Don't create UI yet - wait for sync from periodic interval
    }

    // Listen for room changes from content script and mode changes
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'roomChange') {
            currentPair = request.pair;
            currentMarket = request.market;
            updateChatHeader();
            
            // Clear messages and P&L cache when changing rooms
            messages = [];
            userPnLCache.clear();
            if (pnlService) {
                pnlService.clearCache(); // Clear all cache
            }
            stopPnLPolling();
            
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
                            hasBackendAuth = response.hasBackendAuth || false;
                        }
                        
                        // console.log('✅ Synced with content script from tab:', {
                        //     tabId: tab.id,
                        //     pair: currentPair,
                        //     market: currentMarket,
                        //     messageCount: messages.length,
                        //     walletConnected: !!walletAddress
                        // });
                        
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
                    ` : hasBackendAuth ? `
                    <div class="hl-name-bar">
                        <label class="hl-name-label">As:</label>
                        <select id="hlNameSelect" class="hl-name-select-input">
                            <option value="" ${selectedName === '' ? 'selected' : ''}>${formatAddress(walletAddress)}</option>
                            ${availableNames.map(n => `<option value="${n}" ${n === selectedName ? 'selected' : ''}>${n}</option>`).join('')}
                        </select>
                        <button id="signOutButton" class="hl-sign-out-btn" style="margin-left: 10px; padding: 4px 8px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Sign Out</button>
                    </div>
                    <div class="hl-chat-input-container">
                        <input 
                            type="text" 
                            class="hl-chat-input" 
                            id="messageInput" 
                            placeholder="Chat with ${roomId} traders..."
                            maxlength="250"
                        />
                        <button class="hl-send-btn" id="sendMessage">Send</button>
                    </div>
                    ` : `
                    <div class="hl-chat-auth-bar" id="chatAuthBar">
                        <div class="hl-auth-message">
                            <span>Wallet connected as ${formatAddress(walletAddress)}</span>
                            <button class="hl-connect-btn-small" id="requestSignIn">Sign In to Chat</button>
                        </div>
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

    // Send message (only exists when fully authenticated)
    const sendBtn = document.getElementById('sendMessage');
    if (sendBtn) {
        sendBtn.addEventListener('click', sendMessage);
    }
    
    // Sign In button (when wallet connected but not authenticated)
    const signInBtn = document.getElementById('requestSignIn');
    if (signInBtn) {
        signInBtn.addEventListener('click', async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
                    chrome.tabs.sendMessage(tab.id, { action: 'requestSignIn' });
                } else {
                    alert('Please navigate to app.hyperliquid.xyz/trade to sign in');
                }
            } catch (error) {
                console.error('Failed to request sign in:', error);
            }
        });
    }
    
    // Sign out button
    const signOutBtn = document.getElementById('signOutButton');
    if (signOutBtn) {
        signOutBtn.addEventListener('click', async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
                    chrome.tabs.sendMessage(tab.id, { action: 'signOut' });
                }
            } catch (error) {
                console.error('Failed to sign out:', error);
            }
        });
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
        nameSelect.addEventListener('change', async (e) => {
            selectedName = e.target.value;

            // Store the selected name in Chrome storage
            chrome.storage.local.set({ selectedName: selectedName });

            // Sync with content script
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
                chrome.tabs.sendMessage(tab.id, {
                    action: 'updateSelectedName',
                    selectedName: selectedName
                });
            }
        });
    }

    // Element link clicks - delegated event listener for element links in chat messages
    const messagesContainer = document.getElementById("chatMessages");
    if (messagesContainer) {
        messagesContainer.addEventListener('click', async (event) => {
            const link = event.target.closest('a.hl-element-link');

            if (link) {
                event.preventDefault();
                const elementSelector = link.dataset.elementSelector;
                const elementId = link.dataset.elementId; // Fallback for legacy links

                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

                if (tab && tab.id) {
                    if (elementSelector) {
                        chrome.tabs.sendMessage(tab.id, {
                            action: 'scrollToElement',
                            elementSelector: elementSelector,
                            elementId: elementId
                        }).then((response) => {
                        }).catch((error) => {
                        });
                    } else if (elementId) {
                        // Legacy fallback
                        chrome.tabs.sendMessage(tab.id, {
                            action: 'scrollToElement',
                            elementSelector: elementSelector,
                            elementId: elementId
                        }).then((response) => {
                        }).catch((error) => {
                        });
                    }
                } else {
                    console.warn('No active tab found');
                }
            }
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
        
        // Load P&L data for all users and start polling
        loadAllUserPnL();
        startPnLPolling();

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
            
            // Load P&L for new user if not cached
            if (!userPnLCache.has(msg.address)) {
                loadPnLForAddress(msg.address);
            }
            
            updateMessagesUI();
            scrollToBottom();
        }
    })
    .subscribe((status) => {
        //console.log(`Broadcast subscription status for ${roomId}:`, status);
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
            
            // Load P&L for current user if not cached
            if (!userPnLCache.has(walletAddress)) {
                loadPnLForAddress(walletAddress);
            }
            
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

    const messagesHTML = messages.map((msg, index) => {
        const isOwn = msg.address === walletAddress;
        const displayName = msg.name || formatAddress(msg.address);
        const pnlDisplay = getPnLDisplayForAddress(msg.address);
        const processedContent = replaceElementLinks(escapeHtml(msg.content));

        return `
            <div class="hl-message ${isOwn ? 'own' : ''}">
                <div class="hl-message-header">
                    <div class="hl-message-header-left">
                        <span class="hl-message-address">${displayName}</span>
                    </div>
                    <div class="hl-message-header-right">
                        ${pnlDisplay ? `<span class="hl-pnl-badge" data-address="${msg.address}" style="color: ${pnlDisplay.color};">${pnlDisplay.text}</span>` : ''}
                        <span class="hl-message-time">${formatTime(msg.timestamp)}</span>
                    </div>
                </div>
                <div class="hl-message-content">${processedContent}</div>
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
chrome.runtime.onMessage.addListener((request) => {
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

// P&L Helper Functions
function getPnLDisplayForAddress(address) {
    return userPnLCache.get(address) || null;
}

async function loadAllUserPnL() {
    if (!pnlService) {
        console.warn('P&L service not initialized');
        return;
    }

    // Get unique addresses from messages in current room
    const uniqueAddresses = [...new Set(messages.map(m => m.address).filter(a => a))];
    console.log(`Loading P&L for ${uniqueAddresses.length} users in ${currentPair} room`);

    // Load P&L for each address with delay to avoid rate limiting
    for (let i = 0; i < uniqueAddresses.length; i++) {
        const address = uniqueAddresses[i];
        if (address) {
            await loadPnLForAddress(address);
            // Add 200ms delay between requests to avoid rate limiting
            if (i < uniqueAddresses.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
    }
}

async function loadPnLForAddress(address) {
    if (!pnlService || !address) return;

    try {
        const oldPnL = userPnLCache.get(address);
        console.log(`Loading P&L for ${address} on ${currentPair} ${currentMarket}`);
        
        // Check if this is one of the special addresses
        const normalizedAddress = address.toLowerCase();
        const isSpecialAddress = normalizedAddress === '0xf26f5551e96ae5162509b25925fffa7f07b2d652' || 
                                normalizedAddress === 'testooor.hl';
        
        let pnlDisplay;
        if (isSpecialAddress) {
            // Override with 550k P&L
            pnlDisplay = pnlService.formatPnL(550000);
            console.log(`Special address detected - overriding P&L to +550K`);
        } else {
            pnlDisplay = await pnlService.getPnLDisplay(address, currentPair, currentMarket);
        }
        
        console.log(`P&L result for ${address} on ${currentPair}:`, pnlDisplay);
        
        if (pnlDisplay) {
            userPnLCache.set(address, pnlDisplay);
            
            // Update the UI with animation if P&L changed
            const badge = document.querySelector(`.hl-pnl-badge[data-address="${address}"]`);
            if (badge) {
                // Check if value changed
                if (oldPnL && oldPnL.raw !== pnlDisplay.raw) {
                    // Remove previous animation classes
                    badge.classList.remove('pnl-updating', 'pnl-increase', 'pnl-decrease');
                    
                    // Add updating animation
                    badge.classList.add('pnl-updating');
                    
                    setTimeout(() => {
                        badge.textContent = pnlDisplay.text;
                        badge.style.color = pnlDisplay.color;
                        badge.classList.remove('pnl-updating');
                        
                        // Add increase/decrease animation
                        if (pnlDisplay.raw > oldPnL.raw) {
                            badge.classList.add('pnl-increase');
                        } else if (pnlDisplay.raw < oldPnL.raw) {
                            badge.classList.add('pnl-decrease');
                        }
                        
                        // Remove animation class after animation completes
                        setTimeout(() => {
                            badge.classList.remove('pnl-increase', 'pnl-decrease');
                        }, 600);
                    }, 500);
                } else if (!oldPnL) {
                    // First load, no animation
                    badge.textContent = pnlDisplay.text;
                    badge.style.color = pnlDisplay.color;
                }
            }
        }
    } catch (error) {
        console.error(`Failed to load P&L for ${address}:`, error);
    }
}

function startPnLPolling() {
    // Clear any existing interval
    if (pnlUpdateInterval) {
        clearInterval(pnlUpdateInterval);
    }

    // Poll every 2 minutes (120000ms)
    pnlUpdateInterval = setInterval(() => {
        console.log('Updating P&L data...');
        
        // Clear cache to force fresh data
        if (pnlService) {
            pnlService.clearCache();
        }
        
        // Reload P&L for all users
        loadAllUserPnL();
    }, 120000); // 2 minutes
}

function stopPnLPolling() {
    if (pnlUpdateInterval) {
        clearInterval(pnlUpdateInterval);
        pnlUpdateInterval = null;
    }
}

// Import shared modules at build time
import { ELEMENT_LINK_CONFIG, processElementLinks } from './links-config.js';

// Element links config and utils loaded
let elementLinkConfig = ELEMENT_LINK_CONFIG;
let elementLinksUtils = { processElementLinks };
let configLoaded = true;

// Element links are already loaded inline - no initialization needed

// Replace element links in message content for sidepanel
function replaceElementLinks(content) {
    // Feature isolation: Element links should not break if they fail
    try {
        const configForHost = elementLinkConfig['app.hyperliquid.xyz'];

        if (!configForHost) {
            return content;
        }

        // Use the inline processing function
        const result = processElementLinks(content, configForHost);

        return result;
    } catch (error) {
        console.error('[SidePanel] Failed to replace element links:', error);
        // Return original content if feature fails
        return content;
    }
}

// Initialize when DOM is ready

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initializeSupabase();
    });
} else {
    initializeSupabase();
}
