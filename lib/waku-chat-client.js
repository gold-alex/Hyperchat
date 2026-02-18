import { EnvelopeReceiverFilter } from './waku-receiver-filter.js';
import { etc, getPublicKey, signAsync, utils } from './noble-secp256k1.js';

const SESSION_STORAGE_KEY = 'waku_auth_lite_session_v1';
const SESSION_STORAGE_VERSION = 1;

/**
 * Waku Chat Client - Shared module for Waku chat functionality
 * This module encapsulates all Waku-related logic to avoid duplication
 * between content.js and sidepanel.js
 */

class WakuChatClient {
  constructor(config = {}) {
    // Configuration - prefer config over env (env may not be available in all contexts)
    this.wakuNodeURI = config.wakuNodeURI ?? 'localhost';
    // Ensure port is a number
    const portFromConfig = config.wakuNodePort;
    this.wakuNodePort = typeof portFromConfig === 'string'
      ? parseInt(portFromConfig, 10)
      : (portFromConfig ?? 443);
    this.wakuNodePeerId = config.wakuNodePeerId ?? 'PEER_ID';

    // Add shard configuration
    this.clusterId = 999;
    this.shardId = 0;
    this.numShardsInCluster = typeof config.wakuNumShards === 'number'
      ? config.wakuNumShards
      : undefined;

    // State
    this.waku = null;
    this.ChatMessageProto = null;
    this.messages = [];
    this.currentPair = '';
    this.currentMarket = '';
    this.walletAddress = '';
    this.selectedName = '';
    this.receiverFilter = new EnvelopeReceiverFilter();
    this.gatewayUrl = config.gatewayUrl || config.gatewayURL || '';
    this.gatewayTimeoutMs = config.gatewayTimeoutMs ?? 10000;
    this.gatewayRetryCount = config.gatewayRetryCount ?? 1;
    this.gatewayRetryBaseMs = config.gatewayRetryBaseMs ?? 500;
    this.gatewayChainId = config.gatewayChainId ?? 1;
    this.gatewayDomain = config.gatewayDomain ?? deriveGatewayDomain(this.gatewayUrl);
    this.sessionTtlMs = config.sessionTtlMs ?? 60 * 60 * 1000;
    this.sessionRefreshMs = config.sessionRefreshMs ?? 2 * 60 * 1000;
    this.useLegacyProto = config.useLegacyProto === true || !this.gatewayUrl;
    this.session = null;
    this.siweSigner = config.signMessage || null;
    this._sessionStoragePendingClear = null;

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
        // Prefer plain ws for localhost dev, wss for remote domains
        const isLocal = ['localhost', '127.0.0.1'].includes(String(this.wakuNodeURI).toLowerCase());
        const wsProto = isLocal ? 'ws' : 'wss';
        const fullMultiaddress = `/dns4/${this.wakuNodeURI}/tcp/${this.wakuNodePort}/${wsProto}/p2p/${this.wakuNodePeerId}`;
        console.log("Configuring Waku node to bootstrap with peer:", fullMultiaddress);

        // Use the configured shard/cluster for pubsub topic
        const pubSubTopic = `/waku/2/rs/${this.clusterId}/${this.shardId}`; // Standard sharded format

        console.log(`Creating Waku light node with cluster ${this.clusterId}, shard ${this.shardId}...`);
        console.log('PubSub topic:', pubSubTopic);

        // Create node with proper shard configuration
        const networkConfig = typeof this.numShardsInCluster === 'number'
          ? { clusterId: this.clusterId, numShardsInCluster: this.numShardsInCluster }
          : { clusterId: this.clusterId };

        const libp2pConfig = isLocal
          ? { filterMultiaddrs: false, hideWebSocketInfo: true }
          : { hideWebSocketInfo: true };

        this.waku = await createLightNode({
            defaultBootstrap: false,
            bootstrapPeers: [fullMultiaddress],
            pubsubTopics: [pubSubTopic], // Specify the pubsub topics for sharding
            shardInfo: {
                clusterId: this.clusterId,
                shards: [this.shardId]
            },
            networkConfig,
            // Suppress noisy js-waku websocket discovery banner; keep localhost ws override.
            libp2p: libp2pConfig,
            // In isolated local clusters, explicitly configure service peers to avoid discovery delays
            store: { peers: [fullMultiaddress] },
            filter: { peers: [fullMultiaddress] },
            lightPush: { peers: [fullMultiaddress] }
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
        // Wait for a basic protocol to be available; Store is checked on-demand later
        await waitForRemotePeer(this.waku, [Protocols.Filter, Protocols.LightPush], 15000);

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
    const previousRoom = `${this.currentPair}_${this.currentMarket}`;
    const hadPreviousRoom = Boolean(this.currentPair) && Boolean(this.currentMarket);
    this.currentPair = pair;
    this.currentMarket = market;
    const nextRoom = `${this.currentPair}_${this.currentMarket}`;
    if (hadPreviousRoom && nextRoom && previousRoom !== nextRoom) {
      this.clearSession();
    }
  }

  /**
   * Set the wallet address and optional name
   */
  setWalletInfo(address, name = '') {
    if (this.walletAddress && address && this.walletAddress.toLowerCase() !== address.toLowerCase()) {
      this.clearSession();
    }
    this.walletAddress = address;
    this.selectedName = name;
  }

  setSiweSigner(signer) {
    this.siweSigner = signer;
  }

  clearSession() {
    this.session = null;
    this._sessionStoragePendingClear = this._clearSessionFromStorage();
  }

  /**
   * Get the content topic for the current room
   * Content topics work within the shard's pubsub topic
   */
  getContentTopic() {
    const roomId = `${this.currentPair}_${this.currentMarket}`;
    if (this.useLegacyProto) {
      return `/hl-chat/1/${roomId}/proto`;
    }
    return `/waku-auth-lite/1/${roomId}/json`;
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
      
      // Query store protocol with a proper decoder (required by js-waku API)
      const pubSubTopic = this.getPubSubTopic();
      const decoder = this.waku.createDecoder({
        contentTopic,
        shardId: this.shardId
      });

      const storeQuery = this.waku.store.queryWithOrderedCallback(
        [decoder],
        async (message) => {
          if (!message?.payload) return;
          try {
            const effectivePubsub = (message?.meta?.pubsubTopic) || pubSubTopic;
            if (this.useLegacyProto && this.ChatMessageProto) {
              const decoded = this.ChatMessageProto.decode(message.payload);
              const formatted = {
                ...decoded,
                timestamp: Number(decoded.timestamp),
                address: decoded.address,
                content: decoded.content,
                signature: decoded.signature,
                name: decoded.name || '',
                contentTopic,
                pubsubTopic: effectivePubsub,
              };
              const filterResult = await this.receiverFilter.evaluateMessage(formatted);
              if (!filterResult.accepted) {
                console.log('History message dropped by filter:', filterResult.reason);
                return;
              }
              this.messages.push(formatted);
            } else {
              const payloadBase64 = bytesToBase64(message.payload);
              const filterResult = await this.receiverFilter.evaluateEnvelope(payloadBase64, {
                contentTopic,
                pubsubTopic: effectivePubsub,
              });
              if (!filterResult.accepted) {
                console.log('History message dropped by filter:', filterResult.reason);
                return;
              }
              const formatted = formatEnvelopeMessage(filterResult.envelope, {
                contentTopic,
                pubsubTopic: effectivePubsub,
              });
              this.messages.push(formatted);
            }
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
  async _waitForPeerByProtocol(protocolName, timeout = 15000) {
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

    const callback = async (wakuMessage) => {
      if (!wakuMessage.payload) return;
      try {
        if (this.useLegacyProto && this.ChatMessageProto) {
          const msg = this.ChatMessageProto.decode(wakuMessage.payload);
          if (!this.walletAddress || msg.address.toLowerCase() !== this.walletAddress.toLowerCase()) {
            const message = {
              ...msg,
              timestamp: Number(msg.timestamp),
              address: msg.address,
              content: msg.content,
              signature: msg.signature,
              name: msg.name || '',
              contentTopic,
              pubsubTopic: pubSubTopic
            };
            const filterResult = await this.receiverFilter.evaluateMessage(message);
            if (!filterResult.accepted) {
              console.log('Realtime message dropped by filter:', filterResult.reason);
              return;
            }
            this.messages.push(message);
            this.onMessageReceived(message);
          }
        } else {
          const payloadBase64 = bytesToBase64(wakuMessage.payload);
          const filterResult = await this.receiverFilter.evaluateEnvelope(payloadBase64, {
            contentTopic,
            pubsubTopic: pubSubTopic,
          });
          if (!filterResult.accepted) {
            console.log('Realtime message dropped by filter:', filterResult.reason);
            return;
          }
          const message = formatEnvelopeMessage(filterResult.envelope, {
            contentTopic,
            pubsubTopic: pubSubTopic,
          });
          if (!this.walletAddress || message.address.toLowerCase() !== this.walletAddress.toLowerCase()) {
            this.messages.push(message);
            this.onMessageReceived(message);
          }
        }
      } catch (error) {
        console.error("Failed to decode incoming message:", error);
      }
    };

    // Subscribe using Filter protocol with pubsub topic for sharded networks
    const pubSubTopic = this.getPubSubTopic();
    await this.waku.filter.subscribe([contentTopic], callback, { pubsubTopic: pubSubTopic });
    console.log(`✅ Subscribed to Waku messages on pubsub topic: ${pubSubTopic}`);
  }

  /**
   * Send a message to the network
   */
  async sendMessage(content, signature) {
    if (this.gatewayUrl && !this.useLegacyProto) {
      return this._sendMessageViaGateway(content);
    }
    return this._sendLegacyMessage(content, signature);
  }

  async _sendLegacyMessage(content, signature) {
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
      shardId: this.shardId
    });
    // Send to Waku Network using the encoder and a WakuMessage object
    const pushResult = await this.waku.lightPush.send(encoder, {
        payload,
        timestamp: new Date(timestamp)
      });
    if (!pushResult?.successes?.length) {
      const failure = (pushResult?.failures || [])[0];
      const errorCode = failure?.error || 'UNKNOWN_LIGHTPUSH_FAILURE';
      throw new Error(`LightPush rejected the message (${errorCode}). Check node logs for details.`);
    }

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

  async _sendMessageViaGateway(content) {
    if (!this.walletAddress) {
      throw new Error('Wallet not connected');
    }
    if (!this.gatewayUrl) {
      throw new Error('Gateway URL not configured');
    }
    const session = await this._ensureSession();
    const timestamp = Date.now();
    const metadata = {
      contentTopic: this.getContentTopic(),
      pubsubTopic: this.getPubSubTopic(),
    };
    const envelope = await signEnvelope({
      metadata,
      message: { content, name: this.selectedName || '' },
      senderAddress: this.walletAddress,
      sessionPrivKeyHex: session.sessionPrivKeyHex,
      sessionPubKeyHex: session.sessionPubKeyHex,
      timestampMs: timestamp,
    });
    const payloadBase64 = encodeEnvelopePayload(envelope);
    try {
      await this._gatewayRequest('/message', {
        sessionId: session.sessionId,
        contentTopic: metadata.contentTopic,
        pubsubTopic: metadata.pubsubTopic,
        payloadBase64,
      });
    } catch (error) {
      if (error?.code === 'SESSION_EXPIRED') {
        this.clearSession();
        const refreshed = await this._ensureSession();
        await this._gatewayRequest('/message', {
          sessionId: refreshed.sessionId,
          contentTopic: metadata.contentTopic,
          pubsubTopic: metadata.pubsubTopic,
          payloadBase64,
        });
      } else {
        throw error;
      }
    }
    return {
      timestamp,
      address: this.walletAddress,
      content,
      signature: envelope.signature,
      name: this.selectedName,
      sessionPubKey: envelope.sessionPubKey,
      isOptimistic: true,
    };
  }

  async _ensureSession() {
    const contentTopic = this.getContentTopic();
    const pubsubTopic = this.getPubSubTopic();
    if (this._isSessionValid(contentTopic, pubsubTopic)) {
      return this.session;
    }
    if (this._sessionStoragePendingClear) {
      await this._sessionStoragePendingClear.catch(() => undefined);
      this._sessionStoragePendingClear = null;
    }
    await this._loadSessionFromStorage();
    if (this._isSessionValid(contentTopic, pubsubTopic)) {
      return this.session;
    }
    if (this.session) {
      this.clearSession();
    }
    if (!this.siweSigner) {
      throw new Error('Wallet signer not available');
    }
    const sessionKeypair = generateSessionKeypair();
    const now = Date.now();
    const issuedAt = new Date(now).toISOString();
    const expirationTime = new Date(now + this.sessionTtlMs).toISOString();
    const resources = [
      `urn:waku:contentTopic:${contentTopic}`,
      `urn:waku:pubsubTopic:${pubsubTopic}`,
    ];
    const siweMessage = buildSiweMessage({
      address: this.walletAddress,
      sessionPubKeyHex: sessionKeypair.publicKeyHex,
      nonce: createNonce(),
      issuedAt,
      expirationTime,
      chainId: this.gatewayChainId,
      domain: this.gatewayDomain || 'localhost',
      resources,
    });
    const siweSignature = await this.siweSigner(siweMessage);
    const response = await this._gatewayRequest('/session', {
      siweMessage,
      siweSignature,
      allowedTopics: [contentTopic],
      allowedPubsubTopics: [pubsubTopic],
    });
    if (!response?.sessionId) {
      throw new Error('Gateway session response missing sessionId');
    }
    if (response.sessionPubKey && response.sessionPubKey.toLowerCase() !== sessionKeypair.publicKeyHex.toLowerCase()) {
      throw new Error('Gateway session key mismatch');
    }
    this.session = {
      sessionId: response.sessionId,
      sessionPrivKeyHex: sessionKeypair.privateKeyHex,
      sessionPubKeyHex: sessionKeypair.publicKeyHex,
      expiresAt: response.expiresAt,
      address: this.walletAddress,
      contentTopic,
      pubsubTopic,
      gatewayUrl: this.gatewayUrl || '',
    };
    await this._saveSessionToStorage(this.session);
    return this.session;
  }

  _isSessionValid(contentTopic, pubsubTopic) {
    if (!this.session) return false;
    if (!this.walletAddress) return false;
    if (this.session.address && this.session.address.toLowerCase() !== this.walletAddress.toLowerCase()) {
      return false;
    }
    if (typeof this.session.gatewayUrl === 'string' && this.session.gatewayUrl !== (this.gatewayUrl || '')) {
      return false;
    }
    if (this.session.contentTopic !== contentTopic) return false;
    if (this.session.pubsubTopic !== pubsubTopic) return false;
    const expiresAt = Date.parse(this.session.expiresAt || '');
    if (!Number.isFinite(expiresAt)) return false;
    return Date.now() < expiresAt - this.sessionRefreshMs;
  }

  _getSessionStorageArea() {
    const area = globalThis?.chrome?.storage?.session;
    if (!area) return null;
    if (typeof area.get !== 'function') return null;
    if (typeof area.set !== 'function') return null;
    if (typeof area.remove !== 'function') return null;
    return area;
  }

  async _callStorageMethod(area, method, args = []) {
    const fn = area?.[method];
    if (typeof fn !== 'function') {
      return undefined;
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
          return;
        }
        resolve(value);
      };
      const callback = (value) => {
        const lastError = globalThis?.chrome?.runtime?.lastError;
        if (lastError) {
          finish(undefined, new Error(lastError.message || `chrome.storage.${method} failed`));
          return;
        }
        finish(value);
      };
      try {
        const maybePromise = fn.call(area, ...args, callback);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then((value) => finish(value)).catch((error) => finish(undefined, error));
        } else if (fn.length <= args.length) {
          finish(maybePromise);
        }
      } catch (error) {
        finish(undefined, error);
      }
    });
  }

  _isPersistedSessionShape(value) {
    if (!value || typeof value !== 'object') return false;
    if (value.version !== SESSION_STORAGE_VERSION) return false;
    if (!value.session || typeof value.session !== 'object') return false;
    const session = value.session;
    const requiredFields = [
      'sessionId',
      'sessionPrivKeyHex',
      'sessionPubKeyHex',
      'expiresAt',
      'address',
      'contentTopic',
      'pubsubTopic',
      'gatewayUrl',
    ];
    return requiredFields.every((field) => typeof session[field] === 'string' && session[field].length > 0);
  }

  async _loadSessionFromStorage() {
    if (this.session) return this.session;
    const area = this._getSessionStorageArea();
    if (!area) return null;
    try {
      const stored = await this._callStorageMethod(area, 'get', [SESSION_STORAGE_KEY]);
      const payload = stored?.[SESSION_STORAGE_KEY];
      if (!payload) return null;
      if (!this._isPersistedSessionShape(payload)) {
        await this._clearSessionFromStorage();
        return null;
      }
      if (payload.session.gatewayUrl !== (this.gatewayUrl || '')) {
        await this._clearSessionFromStorage();
        return null;
      }
      this.session = { ...payload.session };
      return this.session;
    } catch (error) {
      console.warn('Failed to load auth-lite session from chrome.storage.session:', error);
      return null;
    }
  }

  async _saveSessionToStorage(session) {
    const area = this._getSessionStorageArea();
    if (!area) return false;
    if (!session || typeof session !== 'object') return false;
    try {
      const payload = {
        version: SESSION_STORAGE_VERSION,
        session: {
          sessionId: String(session.sessionId || ''),
          sessionPrivKeyHex: String(session.sessionPrivKeyHex || ''),
          sessionPubKeyHex: String(session.sessionPubKeyHex || ''),
          expiresAt: String(session.expiresAt || ''),
          address: String(session.address || ''),
          contentTopic: String(session.contentTopic || ''),
          pubsubTopic: String(session.pubsubTopic || ''),
          gatewayUrl: String(session.gatewayUrl || this.gatewayUrl || ''),
        },
      };
      if (!this._isPersistedSessionShape(payload)) {
        return false;
      }
      await this._callStorageMethod(area, 'set', [{ [SESSION_STORAGE_KEY]: payload }]);
      return true;
    } catch (error) {
      console.warn('Failed to persist auth-lite session to chrome.storage.session:', error);
      return false;
    }
  }

  async _clearSessionFromStorage() {
    const area = this._getSessionStorageArea();
    if (!area) return false;
    try {
      await this._callStorageMethod(area, 'remove', [SESSION_STORAGE_KEY]);
      return true;
    } catch (error) {
      console.warn('Failed to clear auth-lite session from chrome.storage.session:', error);
      return false;
    }
  }

  async _gatewayRequest(path, body) {
    if (!this.gatewayUrl) {
      throw new Error('Gateway URL not configured');
    }
    const baseUrl = this.gatewayUrl.replace(/\/+$/, '');
    const url = `${baseUrl}${path}`;
    const attempts = Math.max(0, this.gatewayRetryCount);
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.gatewayTimeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) {
          return await response.json().catch(() => ({}));
        }
        const payload = await response.json().catch(async () => {
          const text = await response.text().catch(() => '');
          return { error: text };
        });
        throw mapGatewayError(response.status, payload?.error || payload?.detail || '');
      } catch (error) {
        clearTimeout(timeout);
        const normalized = normalizeGatewayException(error);
        if (attempt < attempts && shouldRetryGateway(normalized)) {
          const delayMs = this.gatewayRetryBaseMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw normalized;
      }
    }
    throw new Error('Gateway request failed');
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

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function deriveGatewayDomain(gatewayUrl) {
  if (!gatewayUrl) return '';
  try {
    return new URL(gatewayUrl).hostname;
  } catch {
    return '';
  }
}

function bytesToBase64(bytes) {
  return base64Encode(toBytes(bytes));
}

function base64Encode(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  if (typeof btoa !== 'undefined') {
    let binary = '';
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary);
  }
  throw new Error('Base64 encoding not supported in this runtime');
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer);
  if (typeof input === 'string') {
    if (!textEncoder) throw new Error('TextEncoder not available');
    return textEncoder.encode(input);
  }
  return new Uint8Array(input || []);
}

function createNonce(bytes = 8) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure random generator unavailable');
  }
  const array = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(array);
  return etc.bytesToHex(array);
}

function generateSessionKeypair() {
  const privateKey = utils.randomPrivateKey();
  const publicKey = getPublicKey(privateKey, true);
  return {
    privateKeyHex: etc.bytesToHex(privateKey),
    publicKeyHex: etc.bytesToHex(publicKey),
  };
}

function buildSiweMessage(params) {
  const {
    address,
    sessionPubKeyHex,
    nonce,
    issuedAt,
    expirationTime,
    chainId = 1,
    statement,
    domain = 'localhost',
    resources,
  } = params;

  const header = `${domain} wants you to sign in with your Ethereum account:`;
  const body = [header, address, ''];
  if (statement && statement !== header) {
    body.push(statement, '');
  }
  body.push(
    `URI: urn:session:${sessionPubKeyHex}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  );
  if (resources && resources.length) {
    body.push('Resources:', ...resources.map((resource) => `- ${resource}`));
  }
  return body.join('\n');
}

async function signEnvelope(params) {
  const { metadata, message, senderAddress, sessionPrivKeyHex, sessionPubKeyHex, timestampMs } = params;
  const privKeyBytes = etc.hexToBytes(sessionPrivKeyHex);
  const sessionPubKey = sessionPubKeyHex || etc.bytesToHex(getPublicKey(privKeyBytes, true));
  const ts = timestampMs ?? Date.now();
  const hash = await hashEnvelopeContent({ metadata, message, senderAddress, sessionPubKey, timestampMs: ts });
  const signature = await signAsync(hash, privKeyBytes);
  const signatureHex = typeof signature === 'string'
    ? signature
    : signature instanceof Uint8Array
    ? etc.bytesToHex(signature)
    : signature.toCompactHex();
  const messageId = etc.bytesToHex(hash);
  return {
    message,
    senderAddress,
    sessionPubKey,
    timestampMs: ts,
    messageId,
    signature: signatureHex,
  };
}

function canonicalizeEnvelope(params) {
  return JSON.stringify({
    contentTopic: params.metadata.contentTopic,
    pubsubTopic: params.metadata.pubsubTopic,
    message: params.message,
    senderAddress: normalizeAddress(params.senderAddress),
    timestampMs: params.timestampMs,
    sessionPubKey: params.sessionPubKey,
  });
}

async function hashEnvelopeContent(params) {
  const canonical = canonicalizeEnvelope(params);
  const bytes = toBytes(canonical);
  return await sha256Bytes(bytes);
}

async function sha256Bytes(bytes) {
  if (globalThis.crypto?.subtle?.digest) {
    const buffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(buffer);
  }
  try {
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(Buffer.from(bytes)).digest();
    return new Uint8Array(hash);
  } catch (error) {
    throw new Error('SHA-256 not available');
  }
}

function encodeEnvelopePayload(envelope) {
  const json = JSON.stringify(envelope);
  return base64Encode(toBytes(json));
}

function formatEnvelopeMessage(envelope, metadata) {
  const message = envelope?.message || {};
  return {
    timestamp: Number(envelope?.timestampMs || Date.now()),
    address: envelope?.senderAddress || '',
    content: message.content || message.text || '',
    signature: envelope?.signature || '',
    name: message.name || '',
    contentTopic: metadata.contentTopic,
    pubsubTopic: metadata.pubsubTopic,
    messageId: envelope?.messageId,
    sessionPubKey: envelope?.sessionPubKey,
  };
}

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function createGatewayError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function mapGatewayError(status, message) {
  const normalized = String(message || '').toLowerCase();
  let code = 'GATEWAY_ERROR';
  let friendly = message || 'Gateway rejected the request';
  if (status === 401) {
    code = 'SESSION_EXPIRED';
    friendly = 'Session expired. Please re-sign to continue.';
  } else if (status === 429) {
    code = 'RATE_LIMITED';
    friendly = 'Rate limited. Please retry shortly.';
  } else if (status === 403 && normalized.includes('balance')) {
    code = 'UNDER_BALANCE';
    friendly = 'Balance below minimum to send messages.';
  } else if (status === 403 && normalized.includes('topic')) {
    code = 'TOPIC_NOT_ALLOWED';
    friendly = 'This room is not permitted by the gateway.';
  } else if (status === 409 && normalized.includes('nonce')) {
    code = 'NONCE_USED';
    friendly = 'Session nonce already used. Please retry.';
  } else if (status === 409 && normalized.includes('duplicate')) {
    code = 'DUPLICATE_MESSAGE';
    friendly = 'Duplicate message detected.';
  } else if (status >= 500) {
    code = 'GATEWAY_UNAVAILABLE';
    friendly = 'Gateway unavailable. Please retry.';
  }
  return createGatewayError(code, friendly, status);
}

function normalizeGatewayException(error) {
  if (!error) return createGatewayError('GATEWAY_ERROR', 'Gateway request failed');
  if (error.code) return error;
  if (error.name === 'AbortError') {
    return createGatewayError('GATEWAY_TIMEOUT', 'Gateway request timed out');
  }
  if (error.name === 'TypeError') {
    return createGatewayError('GATEWAY_NETWORK', 'Gateway unavailable. Please retry.');
  }
  return error;
}

function shouldRetryGateway(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  if (error.code === 'GATEWAY_UNAVAILABLE') return true;
  if (error.code === 'GATEWAY_NETWORK') return true;
  if (error.code === 'GATEWAY_TIMEOUT') return true;
  if (error.code === 'GATEWAY_ERROR' && error.status >= 500) return true;
  return false;
}

// Export for use in content.js and sidepanel.js
export { WakuChatClient };
