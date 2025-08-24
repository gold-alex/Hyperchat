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
    this.onError = config.onError || ((error) => console.error('WakuChatClient error:', error));
  }

  /**
   * Initialize the Waku node and connect to the network
   */
  async initialize() {
    try {
        console.log('Importing Waku and compiled Protobuf message...');
        const [wakuModule, chatMessageModule] = await Promise.all([
            import(chrome.runtime.getURL('lib/js-waku.min.js')),
            import(chrome.runtime.getURL('lib/chat-message.js')) // This now correctly imports protobuf.min.js
        ]);
        console.log('✅ Libraries imported');
        console.log('chatMessageModule:', chatMessageModule);
        console.log('chatMessageModule keys:', Object.keys(chatMessageModule || {}));

        const { createLightNode } = wakuModule?.default || wakuModule || {};
        
        // The pre-compiled module gives us the message type directly
        if (!chatMessageModule || !chatMessageModule.ChatMessage) {
            throw new Error('ChatMessage not found in imported module');
        }
        this.ChatMessageProto = chatMessageModule.ChatMessage;

        // Use WebSocket for browser connection
        const fullMultiaddress = `/ip4/${this.wakuNodeIP}/tcp/${this.wakuNodePort}/ws/p2p/${this.wakuNodePeerId}`;
        console.log("Configuring Waku node to bootstrap with peer:", fullMultiaddress);

        // Use the correct shard configuration for your custom cluster
        const clusterId = 999;
        const shardId = 42000;
        const pubSubTopic = `/waku/2/rs/${clusterId}/${shardId}`;
        
        console.log(`Creating Waku light node with cluster ${clusterId}, shard ${shardId}...`);
        console.log('PubSub topic:', pubSubTopic);
        
        // Create node with bootstrap peer and shard configuration
        this.waku = await createLightNode({
            defaultBootstrap: false,
            bootstrapPeers: [fullMultiaddress],
            pubsubTopics: [pubSubTopic],
            // Specify the shard info
            shardInfo: {
                clusterId: clusterId,
                shards: [shardId]
            }
        });

        console.log('Starting Waku node...');
        await this.waku.start();
        
        // Manually dial the peer since bootstrap isn't working
        console.log('Manually connecting to peer...');
        try {
            // Import multiaddr parser
            const Multiaddr = (await import(chrome.runtime.getURL('lib/js-waku.min.js'))).multiaddr;
            if (Multiaddr) {
                const ma = Multiaddr(fullMultiaddress);
                await this.waku.libp2p.dial(ma);
                console.log('Manual dial initiated');
            }
        } catch (dialErr) {
            console.error('Manual dial failed:', dialErr);
        }
        
        // Wait for connection with multiple attempts
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log('Checking peer connections...');
        let peers = [];
        for (let i = 0; i < 5; i++) {
            peers = this.waku.libp2p.getPeers ? await this.waku.libp2p.getPeers() : [];
            const connections = this.waku.libp2p.getConnections ? this.waku.libp2p.getConnections() : [];
            console.log(`Attempt ${i+1}: Peers: ${peers.length}, Connections: ${connections.length}`);
            
            if (peers.length > 0) {
                console.log(`✅ Connected to ${peers.length} peer(s)`);
                this.onConnectionStatusChange(true);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        if (peers.length === 0) {
            console.warn('⚠️ No peers connected - messages cannot be sent');
            this.onConnectionStatusChange(false);
        }

        console.log('✅ Protobuf message definition loaded');
        return true;
    } catch (error) {
        console.error('❌ Failed to initialize Waku:', error);
        if (error && error.message) {
            console.error('Error details:', error.message);
            if (error.stack) {
                console.error('Stack:', error.stack);
            }
        }
        this.onConnectionStatusChange(false);
        this.onError(error);
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
   * Content topics work within the shard's pubsub topic
   */
  getContentTopic() {
    const roomId = `${this.currentPair}_${this.currentMarket}`;
    return `/hl-chat/1/${roomId}/proto`;
  }
  
  /**
   * Get the pubsub topic for the shard
   */
  getPubSubTopic() {
    const clusterId = 999;
    const shardId = 42000;
    return `/waku/2/rs/${clusterId}/${shardId}`;
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
          // Final attempt failed, report the error but do not throw!
          this.onError(new Error(`Failed to load chat history after ${maxRetries} attempts. Chat will be in read-only mode.`));
          // Return instead of throwing. This allows the UI to proceed.
          // Also call onHistoryLoaded with an empty array to clear any "loading" state.
          this.onHistoryLoaded([]); 
          return;
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
    const pubSubTopic = this.getPubSubTopic();
    console.log(`Subscribing to Waku Filter on content topic: ${contentTopic}, pubsub topic: ${pubSubTopic}`);

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

    // Subscribe using Filter protocol with pubsub topic for sharded networks
    await this.waku.filter.subscribe([contentTopic], callback, { pubsubTopic: pubSubTopic });
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

    // Check if we have peers before trying to send
    const peers = this.waku.libp2p.getPeers ? await this.waku.libp2p.getPeers() : [];
    if (peers.length === 0) {
      throw new Error('No peers available to send message to');
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
    const pubSubTopic = this.getPubSubTopic();
    
    console.log('Sending message via LightPush:', {
      contentTopic,
      pubSubTopic,
      payloadSize: payload.length,
      peers: peers.length
    });
    
    // Use the proper API format for js-waku
    const wakuMessage = {
      payload,
      contentTopic,
      timestamp: new Date(timestamp)
    };
    
    // For sharded networks, send with the specific pubsub topic
    const encoder = {
      contentTopic,
      pubSubTopic,
      toWire: () => payload,
      toProtoObj: () => wakuMessage
    };
    
    try {
      // Try sending with encoder first
      await this.waku.lightPush.send(encoder, wakuMessage);
    } catch (err) {
      console.error('Encoder send failed, trying direct:', err);
      // Fallback to direct send
      await this.waku.lightPush.send(wakuMessage);
    }

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
