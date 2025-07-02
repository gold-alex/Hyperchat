// Wallet bridge script - runs in page context to access window.ethereum
(function() {
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

  // Listen for wallet connection requests from content script
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'HL_CONNECT_WALLET_REQUEST') {
      try {
        const provider = getProvider();
        if (!provider) {
          throw new Error('No Ethereum wallet found. Please install MetaMask or another Web3 wallet.');
        }

        // Request account access
        const accounts = await provider.request({
          method: 'eth_requestAccounts'
        });

        // Send response back to content script
        window.postMessage({
          type: 'HL_CONNECT_WALLET_RESPONSE',
          id: event.data.id,
          accounts: accounts
        }, '*');

      } catch (error) {
        window.postMessage({
          type: 'HL_CONNECT_WALLET_RESPONSE',
          id: event.data.id,
          error: error.message
        }, '*');
      }
    }

    if (event.data.type === 'HL_SIGN_REQUEST') {
      try {
        const provider = getProvider();
        if (!provider) {
          throw new Error('No Ethereum wallet found.');
        }

        // Sign the message
        const signature = await provider.request({
          method: 'personal_sign',
          params: [event.data.message, event.data.address]
        });

        // Send response back to content script
        window.postMessage({
          type: 'HL_SIGN_RESPONSE',
          id: event.data.id,
          signature: signature
        }, '*');

      } catch (error) {
        window.postMessage({
          type: 'HL_SIGN_RESPONSE',
          id: event.data.id,
          error: error.message
        }, '*');
      }
    }
  });
})(); 