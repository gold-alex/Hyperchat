/**
 * Waku Chat Client - Shared module for Waku chat functionality
 * This module encapsulates all Waku-related logic to avoid duplication
 * between content.js and sidepanel.js
 */

class WakuChatClient {
  constructor(config = {}) {
    // Configuration
    this.wakuNodeIP = config.wakuNodeIP || process.env.WAKU_NODE_IP;
    this.wakuNodePort = config.wakuNodePort || process.env.WAKU_NODE_PORT;
    this.wakuNodePeerId = config.wakuNodePeerId || process.env.WAKU_NODE_PEER_ID;
    
    // State
    this.waku = null;
    this.ChatMessageProto = null;
    this.messages = [];
    this.currentPair = '';
    this.currentMarket = '';
    this.walletAddress = '';
    this.selectedName = '';
    
    // Callbacks
    this.onMessageReceived = config.onMessageReceived || (() => {});
    this.onHistoryLoaded = config.onHistoryLoaded || (() => {});
    this.onConnectionStatusChange = config.onConnectionStatusChange || (() => {});
  }

  /**
   * Initialize the Waku node and connect to the network
   */
  async initialize() {
    try {
        console.log('Importing Waku and Protobuf libraries...');
        const [wakuModule, protobufModule] = await Promise.all([
            import(chrome.runtime.getURL('lib/js-waku.min.js')),
            import(chrome.runtime.getURL('lib/protobuf.js')) // Note: not .min.js
        ]);
        console.log('✅ Libraries imported');

        const { createLightNode } = wakuModule.default || wakuModule;
        
        // The full protobuf.js UMD bundle attaches itself to the window object.
        const protobuf = window.protobuf;

        const fullMultiaddress = `/ip4/${this.wakuNodeIP}/tcp/${this.wakuNodePort}/p2p/${this.wakuNodePeerId}`;
        console.log("Configuring Waku node to bootstrap with peer:", fullMultiaddress);

        // Define PubSub Topic for HyperChat custom testnet
        const pubSubTopic = `/waku/2/hyperchat/proto`;

        console.log('Creating Waku light node...');
        this.waku = await createLightNode({
            defaultBootstrap: false,
            bootstrap: {
                peers: [fullMultiaddress]
            },
            pubSubTopic: pubSubTopic,
        });

        console.log('Starting Waku node...');
        await this.waku.start();
        console.log('✅ Waku node started and is connecting...');
        this.onConnectionStatusChange(true);

        // Load and parse our .proto definition at runtime
        const protoDefinition = await fetch(chrome.runtime.getURL('lib/chat-message.proto')).then(res => res.text());
        const root = protobuf.parse(protoDefinition).root;
        this.ChatMessageProto = root.lookupType("ChatMessage");
        console.log('✅ Protobuf definition loaded');

        return true;
    } catch (error) {
        console.error('❌ Failed to initialize Waku:', error);
        this.onConnectionStatusChange(false);
        return false;
    }
  }


  /**
   * Set the current room (trading pair and market)
   */
  setRoom(pair, market) {
    this.currentPair = pair;
    this.currentMarket = market;
  }

  /**
   * Set the wallet address and optional name
   */
  setWalletInfo(address, name = '') {
    this.walletAddress = address;
    this.selectedName = name;
  }

  /**
   * Get the content topic for the current room
   */
  getContentTopic() {
    const roomId = `${this.currentPair}_${this.currentMarket}`;
    return `/hl-chat/1/${roomId}/proto`;
  }

  /**
   * Load chat history from Waku Store
   */
  async loadHistory() {
    if (!this.waku || !this.ChatMessageProto) {
      console.error("❌ Waku client not initialized!");
      throw new Error("Waku not connected. Cannot load history.");
    }

    const contentTopic = this.getContentTopic();
    console.log(`Querying Waku Store for history on: "${contentTopic}"`);

    // Time range: last 24 hours
    const endTime = new Date();
    const startTime = new Date();
    startTime.setTime(endTime.getTime() - 24 * 60 * 60 * 1000);

    try {
      this.messages = []; // Clear existing messages
      
      // Query store protocol
      const storeQuery = this.waku.store.queryWithOrderedCallback(
        [contentTopic],
        async (message) => {
          if (!message.payload) return;
          try {
            const decoded = this.ChatMessageProto.decode(message.payload);
            this.messages.push({
              ...decoded,
              timestamp: Number(decoded.timestamp),
              address: decoded.address,
              content: decoded.content,
              signature: decoded.signature,
              name: decoded.name || ''
            });
          } catch (error) {
            console.error("Failed to decode message payload:", error);
          }
        },
        {
          timeFilter: { startTime, endTime }
        }
      );

      await storeQuery;

      console.log(`✅ Found ${this.messages.length} historical messages`);
      this.messages.sort((a, b) => a.timestamp - b.timestamp);
      
      this.onHistoryLoaded(this.messages);
      return this.messages;
    } catch (error) {
      console.error("❌ Error loading history from Waku Store:", error);
      throw error;
    }
  }

  /**
   * Load history with retry logic
   */
  async loadHistoryWithRetry(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Loading Waku chat history attempt ${attempt}/${maxRetries}`);
        await this.loadHistory();
        return; // Success, exit retry loop
      } catch (error) {
        console.error(`Waku chat history load attempt ${attempt} failed:`, error);

        if (attempt === maxRetries) {
          throw error; // Re-throw on final attempt
        }

        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  /**
   * Subscribe to real-time messages
   */
  async subscribe() {
    if (!this.waku || !this.ChatMessageProto) {
      console.error("❌ Waku not initialized, cannot subscribe");
      throw new Error("Waku not initialized");
    }

    const contentTopic = this.getContentTopic();
    console.log(`Subscribing to Waku Filter on: ${contentTopic}`);

    const callback = (wakuMessage) => {
      if (!wakuMessage.payload) return;
      try {
        const msg = this.ChatMessageProto.decode(wakuMessage.payload);
        // Only show messages not from ourselves
        if (msg.address.toLowerCase() !== this.walletAddress.toLowerCase()) {
          const message = {
            ...msg,
            timestamp: Number(msg.timestamp),
            address: msg.address,
            content: msg.content,
            signature: msg.signature,
            name: msg.name || ''
          };
          this.messages.push(message);
          this.onMessageReceived(message);
        }
      } catch (error) {
        console.error("Failed to decode incoming message:", error);
      }
    };

    // Subscribe using Filter protocol
    await this.waku.filter.subscribe([contentTopic], callback);
    console.log(`✅ Subscribed to Waku messages.`);
  }

  /**
   * Send a message to the network
   */
  async sendMessage(content, signature) {
    if (!this.waku || !this.ChatMessageProto) {
      throw new Error('Waku is not connected. Messages cannot be sent at this time.');
    }

    if (!this.walletAddress) {
      throw new Error('Wallet not connected');
    }

    const timestamp = Date.now();

    // Create Protobuf message
    const protoMessage = this.ChatMessageProto.create({
      timestamp: timestamp,
      address: this.walletAddress,
      content: content,
      signature: signature,
      name: this.selectedName || ''
    });

    // Encode the message
    const payload = this.ChatMessageProto.encode(protoMessage).finish();

    // Send to Waku Network
    const contentTopic = this.getContentTopic();
    await this.waku.lightPush.send({ 
      contentTopic, 
      payload,
      timestamp: new Date(timestamp)
    });

    console.log('Message sent successfully to Waku network');
    
    // Return the message for optimistic UI updates
    return {
      address: this.walletAddress,
      name: this.selectedName,
      content,
      timestamp,
      signature
    };
  }

  /**
   * Check if Waku is initialized and connected
   */
  isConnected() {
    return !!(this.waku && this.ChatMessageProto);
  }

  /**
   * Clean up and disconnect
   */
  async disconnect() {
    if (this.waku) {
      await this.waku.stop();
      this.waku = null;
      this.ChatMessageProto = null;
      this.onConnectionStatusChange(false);
    }
  }
}

// Export for use in content.js and sidepanel.js
export { WakuChatClient };
