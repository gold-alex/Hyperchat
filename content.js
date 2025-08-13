// Content script that runs on Hyperliquid pages

// Supabase configuration
const SUPABASE_URL = 'https://oltzgkzwgsanlhubelzk.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sdHpna3p3Z3NhbmxodWJlbHprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTEyNTYwMDUsImV4cCI6MjA2NjgzMjAwNX0.Cz0Qv0qQAQMIzNPO-d8-r8xWoUoSRmdgf_S6lpBcDB0'

let supabase;
let chatInstance;

// Initialize Supabase and then start the chat
function initializeSupabase() {
    console.log('Importing Supabase library via dynamic import...');

    // Use dynamic import so that the library executes in the same
    // (isolated) world as the content-script. This avoids page-level CSP
    // issues and also lets us access the exported symbols directly.
    import(chrome.runtime.getURL('supabase.js'))
        .then((supabaseModule) => {
            console.log('✅ Supabase module imported');

            // "supabase.js" is distributed as a UMD bundle. Depending on how
            // the loader evaluates, `createClient` can live in different
            // places. We try the common fall-backs below.
            let createClient = null;

            if (supabaseModule?.supabase?.createClient) {
                // ESM import returned the namespace with `supabase` property.
                createClient = supabaseModule.supabase.createClient;
                console.log('Found createClient on supabaseModule.supabase');
            } else if (supabaseModule?.createClient) {
                // ESM import directly returned the exports object.
                createClient = supabaseModule.createClient;
                console.log('Found createClient on supabaseModule');
            } else if (typeof window !== 'undefined' && window.supabase?.createClient) {
                // UMD bundle attached `supabase` to the global object.
                createClient = window.supabase.createClient;
                console.log('Found createClient on window.supabase');
            }

            if (createClient) {
                supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
                console.log('✅ Supabase client created successfully');
            } else {
                console.error('❌ Could not locate createClient after importing Supabase');
            }
        })
        .catch((error) => {
            console.error('❌ Failed to import Supabase library:', error);
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
    // Don't call init() here - it will be called by initializeChat()
  }

  async init() {
    console.log("Initializing HyperliquidChat...")
    
    // If in standalone mode without overrides, request current market info from active tab
    if (window.IS_STANDALONE_CHAT && !window.CHAT_PAIR_OVERRIDE) {
      console.log("Standalone mode without overrides, requesting market info from active tab")
      try {
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'getCurrentMarketInfo' }, resolve)
        })
        if (response && response.pair && response.market) {
          console.log("Received market info from active tab:", response)
          window.CHAT_PAIR_OVERRIDE = response.pair
          window.CHAT_MARKET_OVERRIDE = response.market
          // Force update current values immediately
          this.currentPair = response.pair
          this.currentMarket = response.market
          console.log("Updated currentPair/currentMarket:", this.currentPair, this.currentMarket)
        }
      } catch (error) {
        console.warn("Failed to get market info from active tab:", error)
      }
    }
    
    // First detect market info and create widget
    this.detectMarketInfo()
    this.createChatWidget()
    this.setupMessageListener()
    this.connectPort()
    this.startMarketMonitoring()
    
    // Wait a moment for DOM to settle and market detection to complete
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    // Load chat history immediately (read-only mode) - Supabase is already initialized
    try {
      console.log("Initializing chat in read-only mode...")
      console.log(`Current trading pair: ${this.currentPair}, market: ${this.currentMarket}`)
      
      if (window.IS_STANDALONE_CHAT) {
        this.showChat();
      }
      
      await this.loadChatHistoryWithRetry()
      console.log("Chat history loaded successfully")
      
      this.subscribeBroadcast() // Can still receive real-time messages
      console.log("Broadcast subscription active")
      
      console.log("Read-only chat initialized successfully")
    } catch (error) {
      console.error("Failed to initialize read-only chat:", error)
      // Don't fail silently - show something to the user
      const messagesContainer = document.getElementById("chatMessages")
      if (messagesContainer) {
        messagesContainer.innerHTML = '<div class="hl-error">Failed to load chat history. Please refresh the page.</div>'
      }
    }
  }

  detectMarketInfo() {
    // console.log("Detecting market info...")
    
    // Allow override when running in standalone tab
    if (window.CHAT_PAIR_OVERRIDE) {
      this.currentPair = window.CHAT_PAIR_OVERRIDE;
      this.currentMarket = window.CHAT_MARKET_OVERRIDE || 'Perps';
      // console.log(`✅ Using overrides - Pair: "${this.currentPair}", Market: "${this.currentMarket}"`)
      return;
    }
    
    // Detect trading pair using the specific coinInfo selector
    let pairElement = document.querySelector("#coinInfo > div > div:nth-child(2) > div:nth-child(1) > div > div > div > div:nth-child(2) > div")
    // console.log("Primary pair element:", pairElement)
    
    // Fallback selectors if the primary one fails
    if (!pairElement || !pairElement.textContent.trim()) {
      // console.log("Primary selector failed, trying fallbacks...")
      pairElement = document.querySelector(".sc-bjfHbI.bFBYgR") ||
                   document.querySelector("[data-testid='trading-pair']") || 
                   document.querySelector(".trading-pair") ||
                   document.querySelector("h1") // fallback to main heading
      // console.log("Fallback pair element:", pairElement)
    }
    
    if (pairElement) {
      const newPair = pairElement.textContent.trim()
      // console.log(`Raw pair text: "${newPair}"`)
      
      if (newPair && newPair !== this.currentPair) {
        // console.log(`Trading pair changed: "${this.currentPair}" -> "${newPair}"`)
        this.currentPair = newPair
      }
    } else {
      console.warn("Could not find trading pair element")
    }

    // Detect market type (Spot vs Perpetuals)
    const spotElement = document.querySelector(
      'div[style*="background: rgb(7, 39, 35)"] .sc-bjfHbI.jxtURp.body12Regular',
    )
    // console.log("Spot detection element:", spotElement)
    const newMarket = spotElement && spotElement.textContent.includes("Spot") ? "Spot" : "Perps"
    // console.log(`Detected market type: "${newMarket}"`)
    
    if (newMarket !== this.currentMarket) {
      // console.log(`Market type changed: "${this.currentMarket}" -> "${newMarket}"`)
      this.currentMarket = newMarket
    }

    const roomId = `${this.currentPair}_${this.currentMarket}`
    // console.log(`Current room ID: "${roomId}"`)
    
    // Fallback if no pair detected
    if (!this.currentPair) {
      this.currentPair = "UNKNOWN"
      console.warn("❌ Could not detect trading pair, using UNKNOWN")
    }
    
    // console.log(`✅ Final market info - Pair: "${this.currentPair}", Market: "${this.currentMarket}", Room: "${roomId}"`)
  }

  createChatWidget() {
    // Remove existing widget if present
    const existing = document.getElementById("hyperliquid-chat-widget")
    if (existing) existing.remove()

    // Create chat widget container
    const widget = document.createElement("div")
    widget.id = "hyperliquid-chat-widget"
    widget.className = "hl-chat-widget"
    // Adjust behavior based on context
    if (!window.IS_STANDALONE_CHAT) {
      // Make resizable via CSS; dragging implemented below
      widget.style.resize = 'both'
      widget.style.overflow = 'hidden'
    } else {
      // In side panel / standalone, fill available space and disable float behaviors
      widget.style.width = '100%'
      widget.style.height = '100%'
      widget.style.position = 'static'
    }

    widget.innerHTML = this.getChatHTML()

    document.body.appendChild(widget)
    // Enable dragging by header only in page-embedded mode
    if (!window.IS_STANDALONE_CHAT) {
      this.enableDrag(widget, widget.querySelector('#moveChat') || widget.querySelector('.hl-chat-header'))
    }
    this.setupEventListeners()
  }

  enableDrag(widget, handleEl) {
    const dragHandle = handleEl
    if (!dragHandle) return
    let startX, startY, startLeft, startTop, isDragging = false
    dragHandle.style.cursor = 'move'

    const onMouseMove = (e) => {
      if (!isDragging) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      widget.style.left = `${startLeft + dx}px`
      widget.style.top = `${startTop + dy}px`
    }
    const onMouseUp = () => {
      isDragging = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    dragHandle.addEventListener('mousedown', (e) => {
      isDragging = true
      startX = e.clientX
      startY = e.clientY
      const rect = widget.getBoundingClientRect()
      startLeft = rect.left
      startTop = rect.top
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    })
  }

  getChatHTML() {
    const roomId = `${this.currentPair}_${this.currentMarket}`
    const isConnected = !!this.walletAddress
    
    return `
      <div class="hl-chat-container ${this.isVisible ? "visible" : ""}">
        <div class="hl-chat-header">
          <div class="hl-chat-title">
            <span class="hl-chat-pair">${this.currentPair}</span>
            <span class="hl-chat-market">${this.currentMarket} Chat</span>
          </div>
          <div class="hl-chat-autoscroll">
            <input type="checkbox" id="autoScrollCheckbox" ${this.autoScroll ? "checked" : ""}>
            <label for="autoScrollCheckbox">Auto-scroll</label>
          </div>
          <div class="hl-chat-controls">
            ${window.IS_STANDALONE_CHAT ? `<button class="hl-chat-popout" id="toggleUIMode" title="Switch extension UI mode">Mode</button>` : ''}
            ${window.IS_STANDALONE_CHAT ? `<button class="hl-chat-popin" id="popInChat" title="Return to page">⇦</button>` : `<button class="hl-chat-popout" id="popOutChat" title="Open in new tab">↗</button>`}
            <button class="hl-chat-close" id="closeChat">×</button>
          </div>
        </div>
        
        <div class="hl-chat-content">
          <div class="hl-chat-messages" id="chatMessages">
            ${this.renderMessages()}
          </div>
          
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
            <input 
              type="text" 
              class="hl-chat-input" 
              id="messageInput" 
              placeholder="Chat with ${roomId} traders..."
              maxlength="500"
            />
            <button class="hl-send-btn" id="sendMessage">Send</button>
          </div>
          `}
        </div>
        
        <div class="hl-chat-toggle" id="chatToggle">
          <span>💬</span>
        </div>
      </div>
    `
  }

  renderMessages() {
    console.log(`Rendering ${this.messages.length} messages`)
    
    if (this.messages.length === 0) {
      console.log("No messages to render")
      return ""
    }
    
    const rendered = this.messages
      .map((msg, index) => {
        console.log(`Rendering message ${index + 1}:`, { content: msg.content, address: msg.address })
        
        const isOwn = msg.address === this.walletAddress
        const displayName = msg.name ? msg.name : this.formatAddress(msg.address)
        const messageHTML = `
      <div class="hl-message ${isOwn ? "own" : ""}">
        <div class="hl-message-header">
          <span class="hl-message-address">${displayName}</span>
          <span class="hl-message-time">${this.formatTime(msg.timestamp)}</span>
        </div>
        <div class="hl-message-content">${this.escapeHtml(msg.content)}</div>
      </div>
    `
        return messageHTML
      })
      .join("")
      
    console.log(`✅ Rendered HTML for ${this.messages.length} messages (${rendered.length} chars)`)
    return rendered
  }

  setupEventListeners() {
    // Toggle chat visibility
    const chatToggle = document.getElementById("chatToggle")
    if (chatToggle) {
      chatToggle.addEventListener("click", () => {
        console.log("Chat toggle clicked")
        this.toggleChat()
      })
    }

    // Refresh chat history
    const refreshChat = document.getElementById("refreshChat")
    if (refreshChat) {
      refreshChat.addEventListener("click", async () => {
        console.log("Refresh chat clicked")
        const messagesContainer = document.getElementById("chatMessages")
        if (messagesContainer) {
          messagesContainer.innerHTML = '<div class="hl-loading">Refreshing chat history...</div>'
        }
        try {
          await this.loadChatHistoryWithRetry()
          console.log("Chat history refreshed successfully")
        } catch (error) {
          console.error("Failed to refresh chat history:", error)
        }
      })
    }

    // Close chat
    const closeChat = document.getElementById("closeChat")
    if (closeChat) {
      closeChat.addEventListener("click", () => {
        this.hideChat()
      })
    }

    // Move chat
    const moveChat = document.getElementById("moveChat")
    if (moveChat) {
      // dragging handled by enableDrag; nothing else needed but cursor set above
    }

    // Minimize chat
    const minimizeChat = document.getElementById("minimizeChat")
    if (minimizeChat) {
      minimizeChat.addEventListener("click", () => {
        this.hideChat()
      })
    }

    // Connect wallet
    const connectWallet = document.getElementById("connectWallet")
    if (connectWallet) {
      connectWallet.addEventListener("click", () => {
        console.log("Connect wallet clicked")
        this.connectWallet()
      })
    }

    // Send message
    const sendMessage = document.getElementById("sendMessage")
    if (sendMessage) {
      sendMessage.addEventListener("click", async () => {
        await this.sendMessage()
      })
    }

    // Enter key to send message
    const messageInput = document.getElementById("messageInput")
    if (messageInput) {
      messageInput.addEventListener("keypress", async (e) => {
        if (e.key === "Enter") {
          await this.sendMessage()
        }
      })
    }

    // Toggle auto-scroll
    const autoScrollCheckbox = document.getElementById("autoScrollCheckbox")
    if (autoScrollCheckbox) {
      autoScrollCheckbox.addEventListener("change", (e) => {
        this.autoScroll = e.target.checked
        console.log(`Auto-scroll set to ${this.autoScroll}`)
        if (this.autoScroll) {
          this.scrollToBottom() // Immediately scroll if re-enabled
        }
      })
    }

    // HL name select
    const nameSelect = document.getElementById("hlNameSelect")
    if (nameSelect) {
      nameSelect.addEventListener("change", (e) => {
        this.selectedName = e.target.value
      })
    }

    // Popout chat
    if (!window.IS_STANDALONE_CHAT) {
      const popBtn = document.getElementById("popOutChat")
      if (popBtn) {
        popBtn.addEventListener("click", () => {
          this.hideChat()
          chrome.runtime.sendMessage({ action: "openStandaloneChat", pair: this.currentPair, market: this.currentMarket })
        })
      }
    } else {
      const popIn = document.getElementById("popInChat")
      if (popIn) {
        popIn.addEventListener("click", () => {
          chrome.runtime.sendMessage({ action: "showChat", pair: this.currentPair, market: this.currentMarket })
          window.close()
        })
      }
      const modeBtn = document.getElementById("toggleUIMode")
      if (modeBtn) {
        modeBtn.addEventListener("click", () => {
          // Set UI mode to popup and open popup in the same operation
          const pair = this.currentPair
          const market = this.currentMarket
          
          // First open the popup, then close the side panel
          chrome.runtime.sendMessage({ 
            action: "switchToPopupMode", 
            pair: pair,
            market: market
          }, () => {
            // Close the side panel after ensuring popup is ready
            window.close()
          })
        })
      }
    }
  }

  // Injects a small script into the actual page context so we can access window.ethereum
  injectWalletBridge() {
    const url = chrome.runtime.getURL('wallet-bridge.js');      // extension-local url
    console.log('[CS] injecting wallet bridge', url)
    const script = document.createElement('script');
    script.src = url;
    script.type = 'text/javascript';
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.addEventListener('load', ()=>console.log('[CS] wallet bridge loaded'))
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
          console.warn('[CS] HL_CONNECT_WALLET_RESPONSE error', event.data.error)
          reject(new Error(event.data.error));
        } else {
          console.log('[CS] HL_CONNECT_WALLET_RESPONSE accounts', event.data.accounts)
          resolve(event.data.accounts);
        }
      };

      window.addEventListener('message', handler);
      console.log('[CS] post HL_CONNECT_WALLET_REQUEST', { id })
      window.postMessage({ type: 'HL_CONNECT_WALLET_REQUEST', id }, '*');
    });
  }

  // Request accounts via background script proxy for side panel
  requestAccountsViaProxy() {
    return new Promise((resolve, reject) => {
      try {
        console.log('[CS] proxyRequestAccounts send')
        chrome.runtime.sendMessage({ action: 'proxyRequestAccounts' }, (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('[CS] proxyRequestAccounts lastError', chrome.runtime.lastError.message)
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (resp && resp.accounts) {
            console.log('[CS] proxyRequestAccounts resp.accounts', resp.accounts)
            resolve(resp.accounts);
          } else {
            console.warn('[CS] proxyRequestAccounts error resp', resp)
            reject(new Error(resp?.error || 'Failed to connect wallet via proxy'));
          }
        });
      } catch (e) {
        console.warn('[CS] proxyRequestAccounts threw', e)
        reject(e);
      }
    });
  }


  async connectWallet() {
    try {
      console.log("Starting wallet connection...")
      const accounts = await (window.IS_STANDALONE_CHAT ? this.requestAccountsViaProxy() : this.requestAccounts())
      console.log("Accounts received:", accounts)
      
      if (accounts && accounts.length > 0) {
        this.walletAddress = accounts[0]
        console.log("Wallet connected:", this.walletAddress)

        // Perform backend authentication to get JWT
        await this.handleBackendAuth()

        // Fetch HL names owned by this wallet and set default
        try {
          this.availableNames = await this.fetchHLNames(this.walletAddress)
          console.log("Available HL names:", this.availableNames)
        } catch (err) {
          console.error("Failed to fetch HL names", err)
        }

        // Recreate the chat widget to show connected state
        // Preserve market info in standalone mode before recreating
        if (window.IS_STANDALONE_CHAT && window.CHAT_PAIR_OVERRIDE) {
          this.currentPair = window.CHAT_PAIR_OVERRIDE
          this.currentMarket = window.CHAT_MARKET_OVERRIDE || 'Perps'
          console.log("Preserving market info before widget recreation:", this.currentPair, this.currentMarket)
        }
        this.createChatWidget()

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
    // Build login message
    const ts = Date.now()
    const loginMsg = `HyperLiquidChat login ${ts}`

    // Ask wallet to sign
    const signature = await this.signMessage(loginMsg)

    // Send to backend (optional - graceful fallback if server unavailable)
    try {
      const resp = await fetch('http://localhost:3001/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: this.walletAddress, signature, timestamp: ts })
      })

      if (!resp.ok) {
        throw new Error(`Authentication failed: ${resp.status}`)
      }

      const data = await resp.json()
      this.jwtToken = data.token
      console.log('✅ Backend auth successful')
    } catch (error) {
      console.warn('⚠️ Backend auth failed, continuing in read-only mode:', error.message)
      // Continue without JWT - user can still read messages but not send
      this.jwtToken = null
    }
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
          const messagesContainer = document.getElementById("chatMessages")
          if (messagesContainer) {
            messagesContainer.innerHTML = `<div class="hl-error">Failed to load chat after ${maxRetries} attempts. <button onclick="location.reload()">Refresh Page</button></div>`
          }
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
      console.warn("❌ Cannot load chat history - trading pair not detected yet")
      return
    }

    // Check if Supabase is initialized
    if (!this.supabase) {
      console.error("❌ Supabase client not initialized!")
      return
    }
    
    console.log("✅ Supabase client is initialized")
    
    try {
      console.log(`Querying Supabase for room: "${roomId}"`)
      console.log(`Query: SELECT * FROM messages WHERE room = '${roomId}' ORDER BY timestamp ASC`)
      
      const { data, error } = await this.supabase
        .from('messages')
        .select('*')
        .eq('room', roomId)
        .order('timestamp', { ascending: true })

      console.log('Supabase response:', { data, error })

      if (error) {
        console.error('❌ Supabase load error:', error)
        console.error('❌ Error details:', {
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

      console.log(`✅ Query successful! Found ${data ? data.length : 0} messages for room "${roomId}"`)
      
      if (data && data.length > 0) {
        console.log('First message sample:', data[0])
        console.log('All message contents:', data.map(m => ({ content: m.content, timestamp: m.timestamp })))
      } else {
        console.log('ℹ️ No messages found for this room')
      }

      // Always set messages (even if empty array)
      this.messages = data || []
      console.log(`✅ Set this.messages to array with ${this.messages.length} items`)
      
      // Update the UI
      const messagesContainer = document.getElementById("chatMessages")
      console.log('Messages container element:', messagesContainer)
      
      if (messagesContainer) {
        if (this.messages.length === 0) {
          const noMessagesHTML = `<div class="hl-loading">No messages yet in ${roomId}. Be the first to chat!</div>`
          console.log('Setting no messages HTML:', noMessagesHTML)
          messagesContainer.innerHTML = noMessagesHTML
        } else {
          const renderedHTML = this.renderMessages()
          console.log('Rendered messages HTML:', renderedHTML)
          messagesContainer.innerHTML = renderedHTML
          this.scrollToBottom()
          console.log('✅ Updated chat UI with messages and scrolled to bottom')
        }
      } else {
        console.error("❌ Messages container not found in DOM!")
        console.log('Available elements with IDs:', Array.from(document.querySelectorAll('[id]')).map(el => el.id))
      }
      
    } catch (err) {
      console.error('❌ Failed to load chat history:', err)
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
          console.log('Adding message to UI:', msg)
          this.messages.push(msg)
          document.getElementById("chatMessages").innerHTML = this.renderMessages()
          this.scrollToBottom()
        } else {
          console.log('Ignoring message - wrong room or own message')
        }
      })
      .subscribe((status) => {
        console.log(`Broadcast subscription status for ${roomId}:`, status)
      })

    this.realtimeChannel = channel
  }

  async sendMessage() {
    const input = document.getElementById("messageInput")
    let content = input.value.trim()

    if (content.length > 500) {
      content = content.substring(0, 500)
      // Optionally alert the user that the message was truncated
      console.warn('Message truncated to 500 characters')
    }

    if (!content || !this.walletAddress) return
    
    // Check if we can send messages (wallet connected, backend optional)
    if (!this.walletAddress) {
      alert('Please connect your wallet to send messages')
      return
    }
    
    // If no JWT token, warn about read-only mode
    if (!this.jwtToken) {
      alert('Backend server unavailable. Messages cannot be sent in read-only mode.\n\nYou can still read messages, but sending requires the backend server.')
      return
    }

    const timestamp = Date.now()
    const nonce = timestamp + Math.random().toString(36).substr(2, 9) // unique nonce
    
    const messageObj = {
      address: this.walletAddress,
      name: this.selectedName,
      content: content,
      timestamp: timestamp,
      pair: this.currentPair,
      market: this.currentMarket,
      room: `${this.currentPair}_${this.currentMarket}`,
      nonce: nonce
    }

    const messageString = JSON.stringify(messageObj)
    console.log('Preparing to send message:', messageObj)

    try {
      // Sign the message string
      const signature = await this.signMessage(messageString)
      console.log('Message signed successfully')

      // Optimistic UI - show message immediately
      this.messages.push({
        address: this.walletAddress,
        name: this.selectedName,
        content: content,
        timestamp: timestamp,
        pair: this.currentPair,
        market: this.currentMarket,
        room: messageObj.room
      })
      input.value = ""
      document.getElementById("chatMessages").innerHTML = this.renderMessages()
      this.scrollToBottom()

      // Send to backend
      const response = await fetch('http://localhost:3001/message', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.jwtToken}`
        },
        body: JSON.stringify({
          signature: signature,
          message: messageString
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
            room: messageObj.room
          }
        })
      }

    } catch (error) {
      console.error('Failed to send message:', error)
      
      // Remove optimistic message on error
      this.messages = this.messages.filter(msg => 
        !(msg.timestamp === timestamp && msg.address === this.walletAddress)
      )
      document.getElementById("chatMessages").innerHTML = this.renderMessages()
      this.scrollToBottom()
      
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
        
        // Update chat header immediately
        this.updateChatHeader()
        
        // Show loading state
        const messagesContainer = document.getElementById("chatMessages")
        if (messagesContainer) {
          messagesContainer.innerHTML = '<div class="hl-loading">Switching to ' + newRoomId + '...</div>'
        }
        
        // Clean up old subscription
        if (this.supabase && this.realtimeChannel) {
          console.log(`Unsubscribing from old room: ${oldRoomId}`)
          this.supabase.removeChannel(this.realtimeChannel)
          this.realtimeChannel = null
        }
        
        // Notify standalone windows
        chrome.runtime.sendMessage({ action: 'roomChange', pair: this.currentPair, market: this.currentMarket })

        // Load new room (works with or without wallet)
        if (this.supabase) {
          console.log(`Loading new room: ${newRoomId}`)
          this.loadChatHistoryWithRetry().then(() => {
            this.subscribeBroadcast()
            console.log(`Successfully switched to room: ${newRoomId}`)
          }).catch(error => {
            console.error("Failed to load new room:", error)
            if (messagesContainer) {
              messagesContainer.innerHTML = '<div class="hl-error">Failed to load chat for ' + newRoomId + '</div>'
            }
          })
        }
        
        // Update input placeholder if wallet is connected
        const inputElement = document.getElementById("messageInput")
        if (inputElement) {
          inputElement.placeholder = `Chat with ${newRoomId} traders...`
        }
      }
    }, 2000)
  }

  updateChatHeader() {
    const pairElement = document.querySelector(".hl-chat-pair")
    const marketElement = document.querySelector(".hl-chat-market")
    const inputElement = document.getElementById("messageInput")

    if (pairElement) pairElement.textContent = this.currentPair
    if (marketElement) marketElement.textContent = `${this.currentMarket} Chat`
    
    // Update input placeholder with current room (only if connected)
    const roomId = `${this.currentPair}_${this.currentMarket}`
    if (inputElement) {
      inputElement.placeholder = `Chat with ${roomId} traders...`
    }
    
    console.log(`Chat header updated for room: ${roomId}`)
  }

  setupMessageListener() {
    window.chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "toggleChat") {
        this.showChat()
      } else if (request.action === 'showChat' && !window.IS_STANDALONE_CHAT) {
        this.currentPair = request.pair || this.currentPair
        this.currentMarket = request.market || this.currentMarket
        this.showChat()
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
      } else if (request.action === 'doRequestAccounts') {
        // Handle proxy request coming from background -> content script
        // Use setTimeout to avoid "message channel closed" by responding immediately
        setTimeout(() => {
          this.requestAccounts().then((accounts) => {
            sendResponse({ accounts })
          }).catch((err) => {
            sendResponse({ error: err?.message || 'Failed to connect wallet' })
          })
        }, 0)
        return true
      } else if (request.action === 'doSignMessage' && typeof request.message === 'string') {
        // Use setTimeout to avoid "message channel closed" by responding immediately  
        setTimeout(() => {
          this.signMessage(request.message).then((signature) => {
            sendResponse({ signature })
          }).catch((err) => {
            sendResponse({ error: err?.message || 'Failed to sign message' })
          })
        }, 0)
        return true
      } else if (request.action === 'getMarketInfo') {
        // Return current market info for side panel initialization
        this.detectMarketInfo() // Refresh current info
        sendResponse({ 
          pair: this.currentPair, 
          market: this.currentMarket 
        })
        return true
      }
    })
  }

  // Establish a long-lived connection so background can detect receiver presence
  connectPort() {
    try {
      if (!this._port) {
        this._port = chrome.runtime.connect({ name: 'hl-content' })
        this._port.onDisconnect.addEventListener(() => {
          this._port = null
        })
      }
    } catch (_) {
      // ignore
    }
  }

  formatAddress(address) {
    return `${address.slice(0, 6)}...${address.slice(-4)}`
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

  scrollToBottom() {
    if (!this.autoScroll) return
    const messagesContainer = document.getElementById("chatMessages")
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight
    }
  }

  toggleChat() {
    this.isVisible = !this.isVisible
    const container = document.querySelector(".hl-chat-container")
    if (container) {
      container.style.opacity = this.isVisible ? '1' : '0'
      container.style.pointerEvents = this.isVisible ? 'auto' : 'none'
      container.classList.toggle("visible", this.isVisible)
    }
  }

  showChat() {
    this.isVisible = true
    let widget = document.getElementById('hyperliquid-chat-widget')
    if (!widget) {
      this.createChatWidget()
      widget = document.getElementById('hyperliquid-chat-widget')
    }
    const container = widget.querySelector('.hl-chat-container')
    if (container) {
      container.classList.add('visible')
    }
  }

  hideChat() {
    this.isVisible = false
    const widget = document.getElementById('hyperliquid-chat-widget')
    if (widget) widget.remove()
  }

  // Ask page context to sign a message
  signMessage(message) {
    if (window.IS_STANDALONE_CHAT) {
      return new Promise((resolve, reject) => {
        try {
          console.log('[CS] proxySignMessage send')
          chrome.runtime.sendMessage({ action: 'proxySignMessage', message, address: this.walletAddress }, (resp) => {
            if (chrome.runtime.lastError) {
              console.warn('[CS] proxySignMessage lastError', chrome.runtime.lastError.message)
              reject(new Error(chrome.runtime.lastError.message))
              return
            }
            if (resp && resp.signature) {
              console.log('[CS] proxySignMessage signature ok')
              resolve(resp.signature)
            } else {
              console.warn('[CS] proxySignMessage error resp', resp)
              reject(new Error(resp?.error || 'Failed to sign message'))
            }
          })
        } catch (e) {
          console.warn('[CS] proxySignMessage threw', e)
          reject(e)
        }
      })
    }
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random();

      const handler = (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'HL_SIGN_RESPONSE' || event.data.id !== id) return;
        window.removeEventListener('message', handler);
        if (event.data.error) {
          console.warn('[CS] HL_SIGN_RESPONSE error', event.data.error)
          reject(new Error(event.data.error));
        } else {
          console.log('[CS] HL_SIGN_RESPONSE signature ok')
          resolve(event.data.signature);
        }
      };

      window.addEventListener('message', handler);
      console.log('[CS] post HL_SIGN_REQUEST', { id })
      window.postMessage({ type: 'HL_SIGN_REQUEST', id, message, address: this.walletAddress }, '*');
    })
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
