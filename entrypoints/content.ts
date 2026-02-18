import { defineContentScript } from 'wxt/sandbox';
import '../styles/content.css';
import { browser } from 'wxt/browser';
import { Hyperchat } from '../src/hyperchat.js';

export default defineContentScript({
  matches: ['https://app.hyperliquid.xyz/trade*'],
  main() {
    const env = (import.meta as any).env ?? {};
    const WAKU_NODE_URI = env.VITE_WAKU_NODE_URI || 'localhost';
    const WAKU_NODE_PORT = Number(env.VITE_WAKU_NODE_PORT) || 443;
    const WAKU_NODE_PEER_ID = env.VITE_WAKU_NODE_PEER_ID || 'PEER_ID';
    const GATEWAY_URL = env.VITE_LIGHTPUSH_GATEWAY_URL || '';
    const HLNAMES_API_KEY = env.VITE_HLNAMES_API_KEY || '';

    let wakuClient: any;
    let chatInstance: Hyperchat | null = null;

    const getAssetUrl = (path: string) => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) return chrome.runtime.getURL(path);
      return path;
    };

    async function initializeWaku() {
      try {
        const wakuModule: any = await import(getAssetUrl('lib/waku-chat-client.js'));
        wakuClient = new wakuModule.WakuChatClient({
          wakuNodeURI: WAKU_NODE_URI,
          wakuNodePort: WAKU_NODE_PORT as any,
          wakuNodePeerId: WAKU_NODE_PEER_ID,
          gatewayUrl: GATEWAY_URL,
          onMessageReceived: (message: any) => { if (chatInstance) chatInstance.handleNewMessage(message); },
          onHistoryLoaded: (messages: any[]) => { if (chatInstance) chatInstance.handleHistoryLoaded(messages); },
          onConnectionStatusChange: (connected: boolean) => { if (chatInstance) chatInstance.handleConnectionStatusChange(connected); },
          onError: (error: any) => { console.error('Waku error:', error); },
        });
        const success = await wakuClient.initialize();
        if (success) {
          console.log('Waku client initialized successfully');
          initializeChat();
        } else {
          console.error('Failed to initialize Waku client');
          initializeChatInReadOnlyMode();
        }
      } catch (error) {
        console.error('Failed to initialize Waku:', error);
        initializeChatInReadOnlyMode();
      }
    }

    function initializeChat() {
      chatInstance = new Hyperchat({ extensionAPI: browser, hlNamesApiKey: HLNAMES_API_KEY });
      chatInstance.wakuClient = wakuClient;
      if (wakuClient?.setSiweSigner) {
        wakuClient.setSiweSigner((message: string) => chatInstance!.signMessage(message));
      }
      chatInstance.init();
    }

    function initializeChatInReadOnlyMode() {
      chatInstance = new Hyperchat({ extensionAPI: browser, hlNamesApiKey: HLNAMES_API_KEY });
      chatInstance.wakuClient = null; // Explicitly null to indicate read-only mode
      chatInstance.init();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { initializeWaku(); });
    else initializeWaku();
  },
});
