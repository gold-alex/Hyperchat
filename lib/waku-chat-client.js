/**
 * Waku Chat Client - Shared module for Waku chat functionality
 * This module encapsulates all Waku-related logic to avoid duplication
 * between content.js and sidepanel.js
 */

class WakuChatClient {
  constructor(config = {}) {
    // Configuration
    this.wakuNodeURI = process.env.WAKU_NODE_URI;
    this.wakuNodePort = process.env.WAKU_NODE_PORT;
    this.wakuNodePeerId = process.env.WAKU_NODE_PEER_ID;

    // Add shard configuration
    this.clusterId = 999;
    this.shardId = 0;

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
        //console.log('Importing Waku and compiled Protobuf message...');
        const [wakuModule, chatMessageModule] = await Promise.all([
            import(chrome.runtime.getURL('lib/js-waku.min.js')),
            import(chrome.runtime.getURL('lib/chat-message.js')) // This now correctly imports protobuf.min.js
        ]);
        // console.log('✅ Libraries imported');
        // console.log('chatMessageModule:', chatMessageModule);
        // console.log('chatMessageModule keys:', Object.keys(chatMessageModule || {}));

        //const { createLightNode } = wakuModule?.default || wakuModule || {};
        const { createLightNode, waitForRemotePeer, Protocols } = wakuModule;

        
        // The pre-compiled module gives us the message type directly
        if (!chatMessageModule || !chatMessageModule.ChatMessage) {
            throw new Error('ChatMessage not found in imported module');
        }
        this.ChatMessageProto = chatMessageModule.ChatMessage;

        // Use WebSocket for browser connection
        const fullMultiaddress = `/dns4/${this.wakuNodeURI}/tcp/${this.wakuNodePort}/wss/p2p/${this.wakuNodePeerId}`;
        console.log("Configuring Waku node to bootstrap with peer:", fullMultiaddress);

        // Use the correct shard configuration for your custom cluster
        const clusterId = 999;
        const shardId = 0; // Match the server's shard configuration
        const pubSubTopic = `/waku/2/rs/${clusterId}/${shardId}`; // Standard sharded format

        console.log(`Creating Waku light node with cluster ${clusterId}, shard ${shardId}...`);
        console.log('PubSub topic:', pubSubTopic);

        // Create node with proper shard configuration
        this.waku = await createLightNode({
            defaultBootstrap: false,
            bootstrapPeers: [fullMultiaddress],
            pubsubTopics: [pubSubTopic], // Specify the pubsub topics for sharding
            shardInfo: {
                clusterId: clusterId,
                shards: [shardId]
            }
        });

        console.log('Starting Waku node...');
        await this.waku.start();
        
        // // Manually dial the peer since bootstrap isn't working
        // console.log('Manually connecting to peer...');
        // try {
        //     // Import multiaddr parser
        //     const Multiaddr = (await import(chrome.runtime.getURL('lib/js-waku.min.js'))).multiaddr;
        //     if (Multiaddr) {
        //         const ma = Multiaddr(fullMultiaddress);
        //         await this.waku.libp2p.dial(ma);
        //         console.log('Manual dial initiated');
        //     }
        // } catch (dialErr) {
        //     console.error('Manual dial failed:', dialErr);
        // }

        console.log('Waiting for connection to peer...');
        await waitForRemotePeer(this.waku, [Protocols.Filter, Protocols.Store, Protocols.LightPush], 5000);

       // --- Start Enhanced Debugging ---
      const allPeerData = await this.waku.libp2p.peerStore.all();
      console.log(`DEBUG: Found ${allPeerData.length} peers in peerStore after initial connection.`);
      for (const peer of allPeerData) {
          console.log(`DEBUG: Peer ${peer.id.toString()} supports protocols: [${peer.protocols.join(', ')}]`);
      }
      // --- End Enhanced Debugging ---

        // Wait for connection with multiple attempts
        //await new Promise(resolve => setTimeout(resolve, 3000));
        
        // console.log('Checking peer connections...');
        // let peers = [];
        // for (let i = 0; i < 5; i++) {
        //     peers = this.waku.libp2p.getPeers ? await this.waku.libp2p.getPeers() : [];
        //     const connections = this.waku.libp2p.getConnections ? this.waku.libp2p.getConnections() : [];
        //     console.log(`Attempt ${i+1}: Peers: ${peers.length}, Connections: ${connections.length}`);
            
        //     if (peers.length > 0) {
        //         console.log(`✅ Connected to ${peers.length} peer(s)`);
        //         this.onConnectionStatusChange(true);
        //         break;
        //     }
        //     await new Promise(resolve => setTimeout(resolve, 2000));
        // }
        
        // if (peers.length === 0) {
        //     console.warn('⚠️ No peers connected - messages cannot be sent');
        //     this.onConnectionStatusChange(false);
        // }

       const peers = await this.waku.libp2p.getPeers();
       if (peers.length > 0) {
         console.log(`✅ Connected to ${peers.length} peer(s)`);
         this.onConnectionStatusChange(true);
         await new Promise(resolve => setTimeout(resolve, 500));
         return true; 
       } else {
        console.error('❌ Failed to connect to any bootstrap peers.');
        this.onConnectionStatusChange(false);
       }
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
    return `/waku/2/rs/${this.clusterId}/${this.shardId}`;
  }

  /**
   * Load chat history from Waku Store
   */
  async loadHistory() {
    if (!this.waku || !this.ChatMessageProto || !this.waku.store || !this.waku.isStarted()) {
      console.error("❌ Waku client not initialized!");
      throw new Error("Waku not connected. Cannot load history.");
    }

    // Wait for a peer that supports the store protocol to be available
    await this._waitForPeerByProtocol("store");

    const contentTopic = this.getContentTopic();
    console.log(`Querying Waku Store for history on: "${contentTopic}"`);

    // Time range: last 12 hours
    const endTime = new Date();
    const startTime = new Date();
    startTime.setTime(endTime.getTime() - 12 * 60 * 60 * 1000);

    try {
      this.messages = []; // Clear existing messages
      
      // Query store protocol
      const pubSubTopic = this.getPubSubTopic();
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
          timeFilter: { startTime, endTime },
          pubsubTopic: pubSubTopic // Specify the sharded pubsub topic
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
   * Waits for at least one peer that supports a given protocol.
   * @private
   */
  async _waitForPeerByProtocol(protocolName, timeout = 7000) {
    const protocolCodec = {
      store: "/vac/waku/store/2.0.0",
      lightpush: "/vac/waku/lightpush/2.0.0"
    }[protocolName.toLowerCase()];

    if (!protocolCodec) throw new Error(`Unknown protocol: ${protocolName}`);

    const start = Date.now();
    while (Date.now() - start < timeout) {
      const peers = await this.waku.libp2p.peerStore.all();
      // --- Start Enhanced Debugging ---
      if (peers.length > 0) {
        console.log(`DEBUG: _waitForPeerByProtocol looking for '${protocolCodec}'. Found ${peers.length} total peers.`);
        for (const peer of peers) {
            console.log(`DEBUG: Checking peer ${peer.id.toString()}, protocols: [${peer.protocols.join(', ')}]`);
        }
      }
      // --- End Enhanced Debugging ---
      const capablePeers = peers.filter((p) =>
        p.protocols.some(advertisedProto => advertisedProto.startsWith(protocolCodec))
      );
      if (capablePeers.length > 0) {
        console.log(`✅ Found ${capablePeers.length} peer(s) supporting the ${protocolName} protocol.`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Timeout waiting for a peer that supports the Waku ${protocolName} protocol.`);
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
    //const pubSubTopic = this.getPubSubTopic();
    console.log(`Subscribing to Waku Filter on content topic: ${contentTopic}`);

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
    const pubSubTopic = this.getPubSubTopic();
    await this.waku.filter.subscribe([contentTopic], callback, { pubsubTopic });
    console.log(`✅ Subscribed to Waku messages on pubsub topic: ${pubSubTopic}`);
  }

  /**
   * Send a message to the network
   */
  async sendMessage(content, signature) {
    if (!this.waku || !this.waku.lightPush || !this.waku.isStarted() || !this.ChatMessageProto) {
      throw new Error('Waku is not connected. Messages cannot be sent at this time.');
    }
    if (!this.walletAddress) {
      throw new Error('Wallet not connected');
    }

    // Wait for a peer that supports the light push protocol to be available
    await this._waitForPeerByProtocol("lightpush");

    const timestamp = Date.now();
    // Create Protobuf message
    const protoMessage = this.ChatMessageProto.create({
        timestamp: BigInt(timestamp),
        address: this.walletAddress,
        content: content,
        signature: signature,
        name: this.selectedName || ''
      });

    // Encode the message
    const payload = this.ChatMessageProto.encode(protoMessage).finish();
    // Create an encoder with the correct content topic and pubsub topic
    const encoder = this.waku.createEncoder({
      contentTopic: this.getContentTopic(),
      pubsubTopic: this.getPubSubTopic() // Add the sharded pubsub topic
    });
    // Send to Waku Network using the encoder and a WakuMessage object
    await this.waku.lightPush.send(encoder, {
        payload,
        timestamp: new Date(timestamp)
      });

    console.log('Message sent successfully to Waku network');
    // Return the message for optimistic UI updates
    return {
        timestamp,
        address: this.walletAddress,
        content,
        signature,
        name: this.selectedName,
        isOptimistic: true
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
