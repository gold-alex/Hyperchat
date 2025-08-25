// Content script that runs on Hyperliquid pages

// Configuration - these should be replaced at build time
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
const BACKEND_PORT = process.env.BACKEND_PORT || 3002

// Load shared modules (will be available via global window.ElementLinks after injection)

let supabase;
let chatInstance;

// Initialize Supabase and then start the chat
function initializeSupabase() {
    // Use dynamic import so that the library executes in the same
    // (isolated) world as the content-script. This avoids page-level CSP
    // issues and also lets us access the exported symbols directly.
    import(chrome.runtime.getURL('supabase.js'))
        .then((supabaseModule) => {
            // "supabase.js" is distributed as a UMD bundle. Depending on how
            // the loader evaluates, `createClient` can live in different
            // places. We try the common fall-backs below.
            let createClient = null;

            if (supabaseModule?.supabase?.createClient) {
                // ESM import returned the namespace with `supabase` property.
                createClient = supabaseModule.supabase.createClient;
            } else if (supabaseModule?.createClient) {
                // ESM import directly returned the exports object.
                createClient = supabaseModule.createClient;
            } else if (typeof window !== 'undefined' && window.supabase?.createClient) {
                // UMD bundle attached `supabase` to the global object.
                createClient = window.supabase.createClient;
            }

            if (createClient) {
                supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            }
        })
        .catch((error) => {
            console.error('Failed to import Supabase library:', error);
        })
        .finally(() => {
            // Proceed with chat initialisation regardless, so the extension
            // still functions (in read-only mode if Supabase isn't available).
            initializeChat();
        });
}

// Initialize the chat once Supabase is ready
function initializeChat() {
    chatInstance = new HyperliquidChat();
    chatInstance.supabase = supabase; // Pass the Supabase instance
    chatInstance.init();
}

class HyperliquidChat {
  constructor() {
    this.isVisible = false
    this.currentPair = ""
    this.currentMarket = ""
    this.walletAddress = ""
    this.messages = []
    this.supabase = null
    this.jwtToken = null
    // Add HL names state
    this.availableNames = []
    this.selectedName = ''
    // Auto-scroll preference (true = always keep view pinned to last message)
    this.autoScroll = true
    // Inject a bridge script into the page to access window.ethereum in the page context
    this.injectWalletBridge()
    // Inject element links configuration
    this.injectElementLinks()
    // Don't call init() here - it will be called by initializeChat()
  }

  // Inject element links configuration into the page context
  injectElementLinks() {
    const url = chrome.runtime.getURL('links-config-global.js');
    const script = document.createElement('script');
    script.src = url;
    script.type = 'text/javascript';
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    // Don't remove script - it needs to stay to provide global variables
  }

  async init() {
    // First detect market info
    this.detectMarketInfo()
    // Don't create floating widget - only sidepanel is supported
    this.setupMessageListener()
    this.startMarketMonitoring()

    // Wait a moment for DOM to settle and market detection to complete
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Restore wallet connection state if it exists
    await this.restoreWalletConnection()

    // Load chat history immediately (read-only mode) - Supabase is already initialized
    try {
      console.log("Initializing chat in read-only mode...")
      console.log(`Current trading pair: ${this.currentPair}, market: ${this.currentMarket}`)

      // Don't show floating chat anymore

      await this.loadChatHistoryWithRetry()
      console.log("Chat history loaded successfully")

      this.subscribeBroadcast() // Can still receive real-time messages
      console.log("Broadcast subscription active")

      console.log("Read-only chat initialized successfully")
    } catch (error) {
      console.error("Failed to initialize read-only chat:", error)
      // Sidepanel will handle error display
    }
  }

  detectMarketInfo() {
    console.log("Detecting market info...")

    // Allow override when running in standalone tab
    if (window.CHAT_PAIR_OVERRIDE) {
      this.currentPair = window.CHAT_PAIR_OVERRIDE;
      this.currentMarket = window.CHAT_MARKET_OVERRIDE || 'Perps';
      return;
    }

    let pairElement = null;
    let newPair = "";

    // Try desktop selector first
    pairElement = document.querySelector("#coinInfo > div > div:nth-child(2) > div:nth-child(1) > div > div > div > div:nth-child(2) > div")

    // Try mobile selector if desktop fails
    if (!pairElement || !pairElement.textContent.trim()) {
      console.log("Desktop selector failed, trying mobile...")
      pairElement = document.querySelector("#root > div:nth-child(2) > div:nth-child(3) > div > div:nth-child(1) > div:nth-child(1) > div > div:nth-child(1) > div > div > div > div:nth-child(2) > div")
    }

    // Try icon-based detection as fallback
    if (!pairElement || !pairElement.textContent.trim()) {
      
      // Look for coin icon and get text after it
      const coinIcon = document.querySelector('img[alt][src*="/coins/"]');
      if (coinIcon) {
        
        // Navigate up to find container with market text
        let container = coinIcon.closest('div[style*="display"]');
        if (container && container.parentElement) {
          // Look for text in parent or siblings
          const textElements = container.parentElement.querySelectorAll('div');
          for (const el of textElements) {
            const text = el.textContent.trim();
            // Look for pattern like "HYPE-USD" or contains USD
            if (text && !text.includes('Welcome') && (text.includes('-USD') || text.match(/^[A-Z]+-USD[C]?$/))) {
              pairElement = el;
              break;
            }
          }
        }
      }
    }

    // Additional fallback selectors
    if (!pairElement || !pairElement.textContent.trim()) {
      pairElement = document.querySelector(".sc-bjfHbI.bFBYgR") ||
                   document.querySelector("[data-testid='trading-pair']") || 
                   document.querySelector(".trading-pair")
    }

    if (pairElement) {
      newPair = pairElement.textContent.trim()
      
      // Clean up text - remove any "Welcome to Hyperliquid" contamination
      if (newPair.includes("Welcome")) {
        // Extract just the trading pair (looks for XXX-USD pattern)
        const match = newPair.match(/([A-Z]+[-]USD[C]?)/);
        if (match) {
          newPair = match[1];
        }
      }

      if (newPair && newPair !== this.currentPair) {
        console.log(`Trading pair changed: "${this.currentPair}" -> "${newPair}"`)
        this.currentPair = newPair
      }
    } else {
      console.warn("Could not find trading pair element")
    }

    // Detect market type (Spot vs Perpetuals)
    const spotElement = document.querySelector(
      'div[style*="background: rgb(7, 39, 35)"] .sc-bjfHbI.jxtURp.body12Regular',
    )
    const newMarket = spotElement && spotElement.textContent.includes("Spot") ? "Spot" : "Perps"

    if (newMarket !== this.currentMarket) {
      console.log(`Market type changed: "${this.currentMarket}" -> "${newMarket}"`)
      this.currentMarket = newMarket
    }

    const roomId = `${this.currentPair}_${this.currentMarket}`
    console.log(`Current room ID: "${roomId}"`)

    // Fallback if no pair detected
    if (!this.currentPair) {
      this.currentPair = "UNKNOWN"
      console.warn("Could not detect trading pair, using UNKNOWN")
    }

    console.log(`Final market info - Pair: "${this.currentPair}", Market: "${this.currentMarket}", Room: "${roomId}"`)
  }

  createChatWidget() {
    // Don't create floating widget anymore - only sidepanel is supported
    console.log("Floating chat widget disabled - use sidepanel instead")
  }

  // Removed floating chat UI methods - only sidepanel is supported

  renderMessages() {
    //console.log(`Rendering ${this.messages.length} messages`)

    if (this.messages.length === 0) {
      console.log("No messages to render")
      return ""
    }

    const rendered = this.messages
      .map((msg, index) => {
        //console.log(`Rendering message ${index + 1}:`, { content: msg.content, address: msg.address })

        const isOwn = msg.address === this.walletAddress
        const displayName = msg.name ? msg.name : this.formatAddress(msg.address)
        const messageHTML = `
      <div class="hl-message ${isOwn ? "own" : ""}">
        <div class="hl-message-header">
          <span class="hl-message-address">${displayName}</span>
          <span class="hl-message-time">${this.formatTime(msg.timestamp)}</span>
        </div>
        <div class="hl-message-content">${this.replaceElementLinks(this.escapeHtml(msg.content))}</div>
      </div>
    `
        return messageHTML
      })
      .join("")

    return rendered
  }

  setupEventListeners() {
    // Event listeners removed - floating chat UI is disabled
  }

  // Injects a small script into the actual page context so we can access window.ethereum
  injectWalletBridge() {
    const url = chrome.runtime.getURL('wallet-bridge.js');      // extension-local url
    const script = document.createElement('script');
    script.src = url;
    script.type = 'text/javascript';
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.remove(); // keep DOM clean
  }

  // Request accounts via the injected bridge
  requestAccounts() {
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random();

      const handler = (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'HL_CONNECT_WALLET_RESPONSE' || event.data.id !== id) return;
        window.removeEventListener('message', handler);
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.accounts);
        }
      };

      window.addEventListener('message', handler);
      window.postMessage({ type: 'HL_CONNECT_WALLET_REQUEST', id }, '*');
    });
  }

  async restoreWalletConnection() {
    try {
      console.log("Checking for stored wallet connection...")

      const result = await new Promise((resolve) => {
        chrome.storage.local.get(['walletConnected', 'walletAddress', 'availableNames', 'selectedName', 'hasBackendAuth'], (data) => {
          resolve(data);
        });
      });

      if (result.walletConnected && result.walletAddress) {
        console.log("Restoring wallet connection:", result.walletAddress);

        // Restore wallet state
        this.walletAddress = result.walletAddress;
        this.availableNames = result.availableNames || [];
        this.selectedName = result.selectedName || '';

        // Try to restore backend auth if it was previously successful
        if (result.hasBackendAuth) {
          try {
            await this.handleBackendAuth();
            console.log("Backend auth restored successfully");
          } catch (error) {
            console.warn("Failed to restore backend auth:", error.message);
          }
        }

        // Don't recreate floating widget - only sidepanel is supported;

        // Notify side panel about restored wallet connection
        chrome.runtime.sendMessage({
          action: 'walletConnected',
          walletAddress: this.walletAddress,
          availableNames: this.availableNames,
          selectedName: this.selectedName,
          hasBackendAuth: !!this.jwtToken
        }).catch(() => {
          // Side panel might not be open, that's OK
        });

        console.log("Wallet connection restored successfully");
      } else {
        console.log("No stored wallet connection found");
      }
    } catch (error) {
      console.error("Failed to restore wallet connection:", error);
    }
  }

  async disconnectWallet() {
    console.log("Disconnecting wallet...");

    // Clear local state
    this.walletAddress = '';
    this.availableNames = [];
    this.selectedName = '';
    this.jwtToken = null;

    // Clear stored wallet state
    chrome.storage.local.remove(['walletConnected', 'walletAddress', 'availableNames', 'selectedName', 'hasBackendAuth']).catch(console.error);

    // Don't recreate floating widget - only sidepanel is supported

    // Notify side panel about wallet disconnection
    chrome.runtime.sendMessage({
      action: 'walletDisconnected'
    }).catch(() => {
      // Side panel might not be open, that's OK
    });

    console.log("Wallet disconnected successfully");
  }

  async connectWallet() {
    try {
      console.log("Starting wallet connection...")
      const accounts = await this.requestAccounts()
      console.log("Accounts received:", accounts)

      if (accounts && accounts.length > 0) {
        this.walletAddress = accounts[0]
        console.log("Wallet connected:", this.walletAddress)

        // Perform backend authentication to get JWT (skip if backend not available)
        try {
          await this.handleBackendAuth()
          console.log("Backend auth successful")
        } catch (error) {
          console.warn("Backend auth failed, continuing without JWT:", error.message)
          // Continue without JWT - wallet is connected for display but can't send messages
        }

        // Fetch HL names owned by this wallet and set default
        try {
          this.availableNames = await this.fetchHLNames(this.walletAddress)
          console.log("Available HL names:", this.availableNames)
        } catch (err) {
          console.error("Failed to fetch HL names", err)
        }

        // Don't recreate floating widget - only sidepanel is supported

        // Store wallet connection state in Chrome storage for persistence
        chrome.storage.local.set({
          walletAddress: this.walletAddress,
          availableNames: this.availableNames,
          selectedName: this.selectedName,
          hasBackendAuth: !!this.jwtToken,
          walletConnected: true
        }).catch(console.error);

        // Notify side panel about wallet connection
        chrome.runtime.sendMessage({
          action: 'walletConnected',
          walletAddress: this.walletAddress,
          availableNames: this.availableNames,
          selectedName: this.selectedName,
          hasBackendAuth: !!this.jwtToken
        }).catch(() => {
          // Side panel might not be open, that's OK
        })

        // Reload chat history with authenticated user
        console.log("Reloading chat history...")
        await this.loadChatHistoryWithRetry()
        console.log("Setting up broadcast subscription...")

        // Unsubscribe from old channel first
        if (this.realtimeChannel) {
          this.supabase.removeChannel(this.realtimeChannel)
        }
        this.subscribeBroadcast()

        console.log("Chat setup complete!")
      } else {
        alert("No accounts returned. Please ensure your wallet is unlocked and try again.")
      }
    } catch (error) {
      console.error("Failed to connect wallet:", error)
      alert(error?.message || "Failed to connect wallet. Please try again.")
    }
  }

  async handleBackendAuth() {
    // Build login message with EIP-712
    const ts = Date.now()
    const nonce = Math.random().toString(36).substring(2, 15)
    
    // Create EIP-712 typed data for login
    // No chainId needed for Hyperliquid (custom L1)
    const typedData = {
      domain: {
        name: 'Hyperliquid Chat',
        version: '1'
      },
      primaryType: 'Login',
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' }
        ],
        Login: [
          { name: 'message', type: 'string' },
          { name: 'timestamp', type: 'uint256' },
          { name: 'nonce', type: 'string' }
        ]
      },
      message: {
        message: 'Sign in to Hyperliquid Chat',
        timestamp: ts,
        nonce: nonce
      }
    }

    // Ask wallet to sign typed data
    const signature = await this.signTypedData(typedData)

    // Send to backend with typed data
    console.log(`Sending auth request to http://localhost:${BACKEND_PORT}/auth`)
    const resp = await fetch(`http://localhost:${BACKEND_PORT}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        address: this.walletAddress, 
        signature, 
        typedData: typedData,
        timestamp: ts 
      })
    })

    if (!resp.ok) {
      const errorText = await resp.text()
      console.error('Backend auth failed:', resp.status, errorText)
      throw new Error(`Authentication failed: ${errorText}`)
    }

    const data = await resp.json()
    this.jwtToken = data.token
  }

  async loadChatHistoryWithRetry(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Loading chat history attempt ${attempt}/${maxRetries}`)
        await this.loadChatHistoryFromSupabase()
        return // Success, exit retry loop
      } catch (error) {
        console.error(`Chat history load attempt ${attempt} failed:`, error)

        if (attempt === maxRetries) {
          // Final attempt failed
          console.error(`Failed to load chat after ${maxRetries} attempts`)
          throw error
        }

        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
      }
    }
  }

  async loadChatHistoryFromSupabase() {
    const roomId = `${this.currentPair}_${this.currentMarket}`
    console.log(`Loading chat history for room: "${roomId}"`)
    console.log(`Current pair: "${this.currentPair}", market: "${this.currentMarket}"`)

    // Make sure we have a valid room ID
    if (!this.currentPair || this.currentPair === "UNKNOWN") {
      console.warn("Cannot load chat history - trading pair not detected yet")
      return
    }

    // Check if Supabase is initialized
    if (!this.supabase) {
      console.error("Supabase client not initialized!")
      return
    }

    try {
      const { data, error } = await this.supabase
        .from('messages')
        .select('*')
        .eq('room', roomId)
        .order('timestamp', { ascending: true })

      //console.log('Supabase response:', { data, error })

      if (error) {
        console.error('Supabase load error:', error)
        console.error('Error details:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code
        })

        // Show error in chat if it's a critical issue
        const messagesContainer = document.getElementById("chatMessages")
        if (messagesContainer && error.code !== 'PGRST116') { // PGRST116 = table doesn't exist, handle gracefully
          messagesContainer.innerHTML = `<div class="hl-error">Database error: ${error.message}</div>`
        }
        throw error // Re-throw to be caught by caller
      }

      console.log(`Query successful! Found ${data ? data.length : 0} messages for room "${roomId}"`)

      if (data && data.length > 0) {
        console.log('First message sample:', data[0])
        console.log('All message contents:', data.map(m => ({ content: m.content, timestamp: m.timestamp })))
      } else {
        console.log('No messages found for this room')
      }

      // Always set messages (even if empty array)
      this.messages = data || []

      // Don't update UI - floating chat is removed, only sidepanel handles UI

    } catch (err) {
      console.error('Failed to load chat history:', err)
      throw err // Re-throw to be handled by caller
    }
  }

  subscribeBroadcast() {
    const roomId = `${this.currentPair}_${this.currentMarket}`
    console.log(`Subscribing to broadcast for room: ${roomId}`)

    const channel = this.supabase.channel(`room_${roomId}`, {
      config: { broadcast: { ack: true } },
    })
      .on('broadcast', { event: 'new-message' }, (payload) => {
        console.log('Received broadcast message:', payload)
        const msg = payload.payload

        // Only show messages for the current room and not from ourselves
        if (msg.room === roomId && msg.address !== this.walletAddress) {
          console.log('Adding message to messages array:', msg)
          this.messages.push(msg)
          // Sidepanel will handle UI updates via message sync
        } else {
          console.log('Ignoring message - wrong room or own message')
        }
      })
      .subscribe((status) => {
        console.log(`Broadcast subscription status for ${roomId}:`, status)
      })

    this.realtimeChannel = channel
  }

  async sendMessageFromSidepanel(content) {
    // Method specifically for sidepanel to send messages
    if (!content || !this.walletAddress) return

    if (content.length > 500) {
      content = content.substring(0, 500)
      console.warn('Message truncated to 500 characters')
    }

    return this.sendMessageInternal(content)
  }

  async sendMessage() {
    const input = document.getElementById("messageInput")
    let content = input?.value?.trim()

    if (!content || !this.walletAddress) return

    if (content.length > 500) {
      content = content.substring(0, 500)
      console.warn('Message truncated to 500 characters')
    }

    // Clear input if it exists
    if (input) input.value = ""
    
    return this.sendMessageInternal(content)
  }

  async sendMessageInternal(content) {
    if (!content || !this.walletAddress) return

    // Check if we have a JWT token (backend authentication)
    if (!this.jwtToken) {
      alert('Backend server not available. Messages cannot be sent at this time.')
      return
    }

    const timestamp = Date.now()
    const nonce = timestamp + Math.random().toString(36).substring(2, 11) // unique nonce
    const room = `${this.currentPair}_${this.currentMarket}`

    // Create EIP-712 typed data for message
    const typedData = {
      domain: {
        name: 'Hyperliquid Chat',
        version: '1'
      },
      primaryType: 'ChatMessage',
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' }
        ],
        ChatMessage: [
          { name: 'room', type: 'string' },
          { name: 'content', type: 'string' },
          { name: 'timestamp', type: 'uint256' },
          { name: 'nonce', type: 'string' }
        ]
      },
      message: {
        room: room,
        content: content,
        timestamp: timestamp,
        nonce: nonce
      }
    }

    console.log('Preparing to send message with EIP-712:', typedData.message)

    try {
      // Sign the typed data
      const signature = await this.signTypedData(typedData)
      console.log('Message signed successfully')

      // Add message to array (sidepanel will handle UI)
      this.messages.push({
        address: this.walletAddress,
        name: this.selectedName,
        content: content,
        timestamp: timestamp,
        pair: this.currentPair,
        market: this.currentMarket,
        room: room
      })

      // Send to backend with typed data
      const response = await fetch(`http://localhost:${BACKEND_PORT}/message`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.jwtToken}`
        },
        body: JSON.stringify({
          signature: signature,
          typedData: typedData,
          address: this.walletAddress,
          name: this.selectedName,
          pair: this.currentPair,
          market: this.currentMarket
        })
      })

      if (!response.ok) {
        const errorData = await response.json()
        console.error('Backend error response:', errorData)
        throw new Error(errorData.error || `Server error: ${response.status}`)
      }

      const result = await response.json()
      console.log('Message sent successfully to backend:', result)

      // Broadcast to other clients for realtime update
      if (this.realtimeChannel) {
        console.log('Broadcasting message to other clients')
        this.realtimeChannel.send({ 
          type: 'broadcast', 
          event: 'new-message', 
          payload: {
            address: this.walletAddress,
            name: this.selectedName,
            content: content,
            timestamp: timestamp,
            pair: this.currentPair,
            market: this.currentMarket,
            room: room
          }
        })
      }

    } catch (error) {
      console.error('Failed to send message:', error)

      // Remove optimistic message on error
      this.messages = this.messages.filter(msg => 
        !(msg.timestamp === timestamp && msg.address === this.walletAddress)
      )

      // Show user-friendly error messages
      let errorMessage = error.message
      if (errorMessage.includes('rate limit')) {
        errorMessage = 'Too many messages! Please wait a moment before sending again.'
      } else if (errorMessage.includes('stale timestamp')) {
        errorMessage = 'Message expired. Please try again.'
      } else if (errorMessage.includes('signature mismatch')) {
        errorMessage = 'Signature verification failed. Please reconnect your wallet.'
      }

      alert(`Failed to send message: ${errorMessage}`)
    }
  }

  async startMarketMonitoring() {
    // Monitor for market changes
    setInterval(() => {
      const oldPair = this.currentPair
      const oldMarket = this.currentMarket
      const oldRoomId = `${oldPair}_${oldMarket}`

      this.detectMarketInfo()

      const newRoomId = `${this.currentPair}_${this.currentMarket}`

      if (oldRoomId !== newRoomId) {
        console.log(`Room changed: ${oldRoomId} -> ${newRoomId}`)

        // Clear current messages
        this.messages = []

        // No UI updates needed - sidepanel handles everything

        // Clean up old subscription
        if (this.supabase && this.realtimeChannel) {
          console.log(`Unsubscribing from old room: ${oldRoomId}`)
          this.supabase.removeChannel(this.realtimeChannel)
          this.realtimeChannel = null
        }

        // Notify all extensions (background, sidepanel, standalone windows)
        chrome.runtime.sendMessage({ 
          action: 'roomChange', 
          pair: this.currentPair, 
          market: this.currentMarket 
        }).catch(() => {
          // Extension might not be ready, that's OK
        })
        
        // Also directly notify the sidepanel with full sync data
        chrome.runtime.sendMessage({
          action: 'syncSidepanel',
          pair: this.currentPair,
          market: this.currentMarket,
          messages: this.messages,
          walletAddress: this.walletAddress,
          availableNames: this.availableNames,
          selectedName: this.selectedName
        }).catch(() => {
          // Sidepanel might not be open, that's OK
        })

        // Load new room (works with or without wallet)
        if (this.supabase) {
          console.log(`Loading new room: ${newRoomId}`)
          this.loadChatHistoryWithRetry().then(() => {
            this.subscribeBroadcast()
            console.log(`Successfully switched to room: ${newRoomId}`)
            
            // Send updated messages to sidepanel after loading
            chrome.runtime.sendMessage({
              action: 'syncSidepanel',
              pair: this.currentPair,
              market: this.currentMarket,
              messages: this.messages,
              walletAddress: this.walletAddress,
              availableNames: this.availableNames,
              selectedName: this.selectedName
            }).catch(() => {})
          }).catch(error => {
            console.error("Failed to load new room:", error)
          })
        }

        // No UI updates needed - sidepanel handles everything
      }
    }, 2000)
  }

  updateChatHeader() {
    // No UI to update - sidepanel handles everything
    const roomId = `${this.currentPair}_${this.currentMarket}`
    console.log(`Room changed to: ${roomId}`)
  }

  setupMessageListener() {
    window.chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (request.action === 'getCurrentRoom') {
        sendResponse({ 
          pair: this.currentPair, 
          market: this.currentMarket,
          messages: this.messages,
          walletAddress: this.walletAddress,
          availableNames: this.availableNames,
          selectedName: this.selectedName,
          hasBackendAuth: !!this.jwtToken
        })
        return true
      } else if (request.action === 'requestWalletConnection') {
        // Handle wallet connection request from side panel
        this.connectWallet()
      } else if (request.action === 'requestSignIn') {
        // Handle sign in request when wallet is connected but backend auth failed
        if (this.walletAddress && !this.jwtToken) {
          this.handleBackendAuth()
            .then(() => {
              console.log("Backend auth successful after sign in request")
              // Notify sidepanel about successful auth
              chrome.runtime.sendMessage({
                action: 'walletConnected',
                walletAddress: this.walletAddress,
                availableNames: this.availableNames,
                selectedName: this.selectedName,
                hasBackendAuth: !!this.jwtToken
              }).catch(() => {})
            })
            .catch(error => {
              console.error("Sign in failed:", error)
              alert("Sign in failed. Please try again.")
            })
        } else if (!this.walletAddress) {
          // Need to connect wallet first
          this.connectWallet()
        }
      } else if (request.action === 'signOut') {
        // Handle sign out request
        this.disconnectWallet()
      } else if (request.action === 'sendMessage') {
        // Handle message sending request from side panel
        if (this.walletAddress) {
          this.selectedName = request.selectedName || this.selectedName
          // Call sendMessage directly with the content
          this.sendMessageFromSidepanel(request.content)
        }
      } else if (request.action === 'roomChange' && window.IS_STANDALONE_CHAT) {
        const { pair, market } = request
        if (!pair || !market) return
        const oldRoom = `${this.currentPair}_${this.currentMarket}`
        const newRoom = `${pair}_${market}`
        if (oldRoom === newRoom) return

        this.currentPair = pair
        this.currentMarket = market
        window.CHAT_PAIR_OVERRIDE = pair;
        window.CHAT_MARKET_OVERRIDE = market;

        // Reset messages and UI
        this.messages = []
        this.updateChatHeader()
        const messagesContainer = document.getElementById('chatMessages')
        if (messagesContainer) messagesContainer.innerHTML = '<div class="hl-loading">Loading…</div>'

        // Supabase channel switch
        if (this.supabase && this.realtimeChannel) {
          this.supabase.removeChannel(this.realtimeChannel)
          this.realtimeChannel = null
        }
        if (this.supabase) {
          this.loadChatHistoryWithRetry().then(()=>{
            this.subscribeBroadcast()
          })
        }
      } else if (request.action === 'syncMessages') {
        // Sync messages with side panel
        sendResponse({
          messages: this.messages,
          currentPair: this.currentPair,
          currentMarket: this.currentMarket
        })
        return true
      } else if (request.action === 'scrollToElement') {
        // Handle element scrolling request from side panel
        const { elementSelector, elementId } = request;

        if (!elementSelector && !elementId) {
          return;
        }

        const selectorToUse = elementSelector || elementId;

        this.scrollToElement(selectorToUse);
      }
    })
  }

  formatAddress(address) {
    return `${address.slice(0, 6)}...${address.slice(-4)}`
  }

  // Find element by text content for :contains() selectors
  findElementByText(selector) {
    try {
      // Parse selector like "div:contains('Open Interest')" or "div:contains('Funding Rate')"
      const containsMatch = selector.match(/^(.+?):contains\(['"](.+?)['"]\)$/);
      if (!containsMatch) {
        console.warn(`Invalid :contains() selector format: ${selector}`);
        return null;
      }

      const baseSelector = containsMatch[1]; // e.g., "div"
      const searchText = containsMatch[2];   // e.g., "Open Interest"

      console.log(`Searching for ${baseSelector} elements containing: "${searchText}"`);

      // Find all elements matching the base selector
      const candidates = document.querySelectorAll(baseSelector);
      console.log(`Found ${candidates.length} candidate elements with selector: ${baseSelector}`);

      // Find the one that contains the search text
      for (const candidate of candidates) {
        const textContent = candidate.textContent || '';
        if (textContent.toLowerCase().includes(searchText.toLowerCase())) {
          console.log(`Found element containing "${searchText}":`, candidate);
          return candidate;
        }
      }

      console.warn(`No ${baseSelector} element found containing: "${searchText}"`);
      return null;
    } catch (error) {
      console.error('Error in findElementByText:', error);
      return null;
    }
  }

  // Scroll to a specific element on the page
  scrollToElement(selector) {
    let element;

    if (selector.startsWith('#')) {
      // Handle ID selectors
      const elementId = selector.substring(1);
      console.log(`🔍 Searching for element with ID: ${elementId}`);
      element = document.getElementById(elementId);
      if (!element) {
        console.warn(`Element with ID '${elementId}' not found. Available IDs:`,
          Array.from(document.querySelectorAll('[id]')).map(el => el.id).filter(id => id.toLowerCase().includes('info') || id.toLowerCase().includes('coin')));
      }
    } else {
      // Handle complex selectors - try standard querySelector first
      try {
        element = document.querySelector(selector);
      } catch (queryError) {
        element = null;
      }

      // If standard selector fails, check for :contains() pseudo-selector
      if (!element && selector.includes(':contains(')) {

        // Parse selector like "div:contains('Open Interest')"
        const containsMatch = selector.match(/^(.+?):contains\(['"](.+?)['"]\)$/);
        if (containsMatch) {
          const baseSelector = containsMatch[1]; // e.g., "div"
          const searchText = containsMatch[2];   // e.g., "Open Interest"

          try {
            // Find all elements matching the base selector
            const candidates = document.querySelectorAll(baseSelector);

            // Find the one that contains the search text (prefer smaller, more specific elements)
            let bestCandidate = null;
            let smallestSize = Infinity;

            for (const candidate of candidates) {
              const textContent = candidate.textContent || '';
              if (textContent.toLowerCase().includes(searchText.toLowerCase())) {
                // Calculate element "size" (width * height) to prefer smaller, more specific elements
                const rect = candidate.getBoundingClientRect();
                const size = rect.width * rect.height;

                // Prefer elements that are visible and not too large
                if (size > 0 && size < smallestSize && size < 100000) { // Avoid very large elements
                  smallestSize = size;
                  bestCandidate = candidate;
                  console.log(`Found candidate containing "${searchText}" (size: ${size}):`, candidate);
                }
              }
            }

            if (bestCandidate) {
              element = bestCandidate;
              console.log(`Selected best element containing "${searchText}":`, element);
            }

            if (!element) {
              console.warn(`No ${baseSelector} element found containing: "${searchText}"`);
            }
          } catch (containsError) {
            console.error(`Error searching for :contains() selector:`, containsError);
          }
        } else {
          console.warn(`Invalid :contains() selector format: ${selector}`);
        }
      }
    }

    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Add temporary highlight effect
      element.classList.add('hl-element-highlight');
      setTimeout(() => {
        element.classList.remove('hl-element-highlight');
      }, 2000);
    } else {
    }
  }

  formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  escapeHtml(text) {
    const div = document.createElement("div")
    div.textContent = text
    return div.innerHTML
  }

  // No UI methods needed - sidepanel handles everything

  // Floating chat methods removed - only sidepanel is supported

  // Ask page context to sign a message
  signMessage(message) {
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random();

      const handler = (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'HL_SIGN_RESPONSE' || event.data.id !== id) return;
        window.removeEventListener('message', handler);
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.signature);
        }
      };

      window.addEventListener('message', handler);
      window.postMessage({ type: 'HL_SIGN_REQUEST', id, message, address: this.walletAddress }, '*');
    });
  }

  // Sign typed data using EIP-712
  signTypedData(typedData) {
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random();

      const handler = (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'HL_SIGN_RESPONSE' || event.data.id !== id) return;
        window.removeEventListener('message', handler);
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.signature);
        }
      };

      window.addEventListener('message', handler);
      window.postMessage({ type: 'HL_SIGN_REQUEST', id, typedData, address: this.walletAddress }, '*');
    });
  }

  // Fetch HL names owned by an address via public API
  async fetchHLNames(address) {
    try {
      const resp = await fetch(`https://api.hlnames.xyz/utils/names_owner/${address}`, {
        headers: {
          'X-API-Key': 'CPEPKMI-HUSUX6I-SE2DHEA-YYWFG5Y'
        }
      })
      if (!resp.ok) {
        console.error("HL names API returned", resp.status)
        return []
      }
      const data = await resp.json()
      if (!Array.isArray(data)) return []
      return data.map((x) => x.name).filter(Boolean)
    } catch (err) {
      console.error("Error fetching HL names", err)
      return []
    }
  }

  // Replace element links in message content
  _replaceElementLinks(content) {
    // Feature isolation: Element links should not break if they fail
    try {
      // Check if ElementLinks is available globally
      if (!window.ElementLinks) {
        return content;
      }

      const { ELEMENT_LINK_CONFIG, processElementLinks } = window.ElementLinks;
      const configForHost = ELEMENT_LINK_CONFIG[window.location.hostname];
      if (!configForHost) {
        return content;
      }

      // Use the shared utility function
      return processElementLinks(content, configForHost);
    } catch (error) {
      console.error('[ElementLinks] Failed to replace element links:', error);
      // Return original content if feature fails
      return content;
    }
  }
}

// Initialize chat when page loads
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    initializeSupabase()
  })
} else {
  initializeSupabase()
}

// Export for testing purposes
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HyperliquidChat };
}
