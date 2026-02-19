// Wallet bridge script - runs in page context to access window.ethereum
(function() {
  let bridgeAuthToken = null;
  let activeBridgeChannel = null;
  const consumedNonces = new Map();
  const NONCE_MAX_AGE_MS = 15000;
  const NONCE_MAX_TTL_MS = 30000;
  const NONCE_CACHE_MAX = 2000;
  const CHANNEL_MAX_AGE_MS = 15000;
  const CHANNEL_MAX_TTL_MS = 60000;

  /**
   * Returns the most appropriate EIP-1193 provider.
   * Priority:
   *   1. Rabby (isRabby flag)
   *   2. MetaMask (isMetaMask flag)
   *   3. First provider in window.ethereum.providers array
   *   4. window.ethereum itself
   */
  function getProvider() {
    if (typeof window === 'undefined') return null;

    const { ethereum } = window;
    if (!ethereum) return null;

    // If multiple wallets injected, they appear in ethereum.providers (EIP-5749)
    if (Array.isArray(ethereum.providers)) {
      const rabby = ethereum.providers.find((p) => p.isRabby);
      if (rabby) return rabby;

      const metamask = ethereum.providers.find((p) => p.isMetaMask);
      if (metamask) return metamask;

      return ethereum.providers[0];
    }

    return ethereum;
  }

  function logBridgeEvent(level, event, details = {}) {
    if (typeof console?.[level] !== 'function') return;
    console[level]('wallet_bridge.event', {
      event,
      ...details,
    });
  }

  function postAuthError(responseType, id, nonce, channelSessionId, message) {
    logBridgeEvent('warn', 'wallet_bridge.reject', {
      responseType,
      id,
      nonce,
      channelSessionId,
      reason: message || 'Bridge authentication failed',
    });
    window.postMessage({
      type: responseType,
      id,
      nonce,
      channelSessionId,
      error: message || 'Bridge authentication failed',
    }, '*');
  }

  function isValidAuthToken(value) {
    return typeof value === 'string' && value.trim().length >= 12;
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function isValidBridgeNonce(value) {
    return typeof value === 'string' && value.trim().length >= 12;
  }

  function isValidBridgeChannelSessionId(value) {
    return typeof value === 'string' && value.trim().length >= 12;
  }

  function pruneConsumedNonces(nowMs) {
    for (const [nonce, expiresAtMs] of consumedNonces.entries()) {
      if (expiresAtMs <= nowMs) consumedNonces.delete(nonce);
    }
    while (consumedNonces.size > NONCE_CACHE_MAX) {
      const oldest = consumedNonces.keys().next().value;
      if (!oldest) break;
      consumedNonces.delete(oldest);
    }
  }

  function validateAndConsumeNonce(data) {
    const nonce = data?.nonce;
    const requestTsMs = data?.requestTsMs;
    const nonceExpiresAtMs = data?.nonceExpiresAtMs;
    const nowMs = Date.now();

    if (!isValidBridgeNonce(nonce) || !isFiniteNumber(requestTsMs) || !isFiniteNumber(nonceExpiresAtMs)) {
      return { ok: false, nonce, error: 'Bridge nonce missing or invalid' };
    }
    if (nonceExpiresAtMs <= requestTsMs || (nonceExpiresAtMs - requestTsMs) > NONCE_MAX_TTL_MS) {
      return { ok: false, nonce, error: 'Bridge nonce missing or invalid' };
    }
    if ((nowMs - requestTsMs) > NONCE_MAX_AGE_MS || nowMs > nonceExpiresAtMs) {
      return { ok: false, nonce, error: 'Bridge nonce expired' };
    }

    pruneConsumedNonces(nowMs);
    if (consumedNonces.has(nonce)) {
      return { ok: false, nonce, error: 'Bridge nonce replay detected' };
    }

    consumedNonces.set(nonce, Math.max(nowMs + NONCE_MAX_AGE_MS, nonceExpiresAtMs));
    return { ok: true, nonce };
  }

  function getNowMs() {
    return Date.now();
  }

  function pruneBridgeChannel(nowMs) {
    if (activeBridgeChannel && activeBridgeChannel.expiresAtMs <= nowMs) {
      activeBridgeChannel = null;
    }
  }

  function validateBridgeChannel(data) {
    const nowMs = getNowMs();
    pruneBridgeChannel(nowMs);
    if (!activeBridgeChannel) {
      return { ok: false, error: 'Bridge channel not established' };
    }
    if (!isValidBridgeChannelSessionId(data?.channelSessionId)) {
      return { ok: false, error: 'Bridge channel missing or invalid' };
    }
    if (data.channelSessionId !== activeBridgeChannel.sessionId) {
      return { ok: false, error: 'Bridge channel session mismatch' };
    }
    if (!isFiniteNumber(data?.channelIssuedAtMs) || !isFiniteNumber(data?.channelExpiresAtMs)) {
      return { ok: false, error: 'Bridge channel missing or invalid' };
    }
    if (data.channelExpiresAtMs <= data.channelIssuedAtMs || (data.channelExpiresAtMs - data.channelIssuedAtMs) > CHANNEL_MAX_TTL_MS) {
      return { ok: false, error: 'Bridge channel missing or invalid' };
    }
    if ((nowMs - data.channelIssuedAtMs) > CHANNEL_MAX_AGE_MS || nowMs > data.channelExpiresAtMs) {
      return { ok: false, error: 'Bridge channel expired' };
    }
    if (data.channelExpiresAtMs > activeBridgeChannel.expiresAtMs) {
      return { ok: false, error: 'Bridge channel session mismatch' };
    }
    return { ok: true };
  }

  // Listen for wallet connection requests from content script
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'HL_BRIDGE_AUTH_INIT') {
      const requestedToken = event.data.authToken;
      if (!isValidAuthToken(requestedToken)) {
        window.postMessage({
          type: 'HL_BRIDGE_AUTH_RESPONSE',
          id: event.data.id,
          error: 'Invalid bridge auth token',
        }, '*');
        return;
      }

      if (bridgeAuthToken && bridgeAuthToken !== requestedToken) {
        window.postMessage({
          type: 'HL_BRIDGE_AUTH_RESPONSE',
          id: event.data.id,
          error: 'Bridge auth token mismatch',
        }, '*');
        return;
      }

      bridgeAuthToken = requestedToken;
      window.postMessage({
        type: 'HL_BRIDGE_AUTH_RESPONSE',
        id: event.data.id,
        ok: true,
      }, '*');
      return;
    }

    if (event.data.type === 'HL_BRIDGE_BOOTSTRAP_REQUEST') {
      const requestedToken = event.data.authToken;
      if (!isValidAuthToken(requestedToken)) {
        window.postMessage({
          type: 'HL_BRIDGE_BOOTSTRAP_RESPONSE',
          id: event.data.id,
          channelSessionId: event.data.channelSessionId,
          error: 'Invalid bridge auth token',
        }, '*');
        return;
      }
      if (bridgeAuthToken && bridgeAuthToken !== requestedToken) {
        window.postMessage({
          type: 'HL_BRIDGE_BOOTSTRAP_RESPONSE',
          id: event.data.id,
          channelSessionId: event.data.channelSessionId,
          error: 'Bridge auth token mismatch',
        }, '*');
        return;
      }
      const nowMs = getNowMs();
      const channelSessionId = event.data.channelSessionId;
      const channelIssuedAtMs = event.data.channelIssuedAtMs;
      const channelExpiresAtMs = event.data.channelExpiresAtMs;
      if (
        !isValidBridgeChannelSessionId(channelSessionId)
        || !isFiniteNumber(channelIssuedAtMs)
        || !isFiniteNumber(channelExpiresAtMs)
        || channelExpiresAtMs <= channelIssuedAtMs
        || (channelExpiresAtMs - channelIssuedAtMs) > CHANNEL_MAX_TTL_MS
        || (nowMs - channelIssuedAtMs) > CHANNEL_MAX_AGE_MS
        || nowMs > channelExpiresAtMs
      ) {
        window.postMessage({
          type: 'HL_BRIDGE_BOOTSTRAP_RESPONSE',
          id: event.data.id,
          channelSessionId,
          error: 'Bridge channel missing or invalid',
        }, '*');
        return;
      }
      bridgeAuthToken = requestedToken;
      activeBridgeChannel = {
        sessionId: channelSessionId,
        expiresAtMs: channelExpiresAtMs,
      };
      logBridgeEvent('info', 'wallet_bridge.bootstrap_ready', {
        channelSessionId,
        channelExpiresAtMs,
      });
      window.postMessage({
        type: 'HL_BRIDGE_BOOTSTRAP_RESPONSE',
        id: event.data.id,
        ok: true,
        channelSessionId,
        channelExpiresAtMs,
      }, '*');
      return;
    }

    if (event.data.type === 'HL_CONNECT_WALLET_REQUEST') {
      if (!bridgeAuthToken || event.data.authToken !== bridgeAuthToken) {
        postAuthError('HL_CONNECT_WALLET_RESPONSE', event.data.id, event.data.nonce, event.data.channelSessionId, 'Bridge authentication failed');
        return;
      }

      const channelState = validateBridgeChannel(event.data);
      if (!channelState.ok) {
        postAuthError('HL_CONNECT_WALLET_RESPONSE', event.data.id, event.data.nonce, event.data.channelSessionId, channelState.error);
        return;
      }

      const nonceState = validateAndConsumeNonce(event.data);
      if (!nonceState.ok) {
        postAuthError('HL_CONNECT_WALLET_RESPONSE', event.data.id, nonceState.nonce, event.data.channelSessionId, nonceState.error);
        return;
      }
      try {
        const provider = getProvider();
        if (!provider) {
          throw new Error('No Ethereum wallet found. Please install MetaMask or another Web3 wallet.');
        }

        // Request account access
        console.log('[BRIDGE] eth_requestAccounts');
        const accounts = await provider.request({
          method: 'eth_requestAccounts'
        });
        console.log('[BRIDGE] accounts', accounts);

        // Send response back to content script
        window.postMessage({
          type: 'HL_CONNECT_WALLET_RESPONSE',
          id: event.data.id,
          nonce: event.data.nonce,
          channelSessionId: event.data.channelSessionId,
          accounts: accounts
        }, '*');

      } catch (error) {
        window.postMessage({
          type: 'HL_CONNECT_WALLET_RESPONSE',
          id: event.data.id,
          nonce: event.data.nonce,
          channelSessionId: event.data.channelSessionId,
          error: error.message
        }, '*');
      }
    }

    if (event.data.type === 'HL_SIGN_REQUEST') {
      if (!bridgeAuthToken || event.data.authToken !== bridgeAuthToken) {
        postAuthError('HL_SIGN_RESPONSE', event.data.id, event.data.nonce, event.data.channelSessionId, 'Bridge authentication failed');
        return;
      }

      const channelState = validateBridgeChannel(event.data);
      if (!channelState.ok) {
        postAuthError('HL_SIGN_RESPONSE', event.data.id, event.data.nonce, event.data.channelSessionId, channelState.error);
        return;
      }

      const nonceState = validateAndConsumeNonce(event.data);
      if (!nonceState.ok) {
        postAuthError('HL_SIGN_RESPONSE', event.data.id, nonceState.nonce, event.data.channelSessionId, nonceState.error);
        return;
      }
      try {
        const provider = getProvider();
        if (!provider) {
          throw new Error('No Ethereum wallet found.');
        }

        // Ensure we use the provider's currently selected address for personal_sign
        let accounts = [];
        try {
          console.log('[BRIDGE] eth_accounts');
          accounts = await provider.request({ method: 'eth_accounts' });
        } catch (_) {
          // Some providers require requestAccounts prior to fetching accounts
          console.log('[BRIDGE] eth_requestAccounts (fallback)');
          accounts = await provider.request({ method: 'eth_requestAccounts' });
        }
        const from = Array.isArray(accounts) && accounts.length > 0 ? accounts[0] : event.data.address;
        console.log('[BRIDGE] using from', from);
        if (!from) {
          throw new Error('No wallet account available for signing');
        }

        // Sign the message
        console.log('[BRIDGE] personal_sign');
        const signature = await provider.request({
          method: 'personal_sign',
          params: [event.data.message, from]
        });
        console.log('[BRIDGE] signature length', signature && signature.length);

        // Send response back to content script
        window.postMessage({
          type: 'HL_SIGN_RESPONSE',
          id: event.data.id,
          nonce: event.data.nonce,
          channelSessionId: event.data.channelSessionId,
          signature: signature
        }, '*');

      } catch (error) {
        window.postMessage({
          type: 'HL_SIGN_RESPONSE',
          id: event.data.id,
          nonce: event.data.nonce,
          channelSessionId: event.data.channelSessionId,
          error: error.message
        }, '*');
      }
    }
  });
})();
