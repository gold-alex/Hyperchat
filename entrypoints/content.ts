import { defineContentScript } from 'wxt/sandbox';
import '../content.css';
import { browser } from 'wxt/browser';
import { HyperliquidChat } from '../src/hyperliquid-chat.js';

export default defineContentScript({
  matches: ['https://app.hyperliquid.xyz/trade*'],
  main() {
    const env = (import.meta as any).env ?? {};
    const WAKU_NODE_URI = env.VITE_WAKU_NODE_URI || 'localhost';
    const WAKU_NODE_PORT = Number(env.VITE_WAKU_NODE_PORT) || 443;
    const WAKU_NODE_PEER_ID = env.VITE_WAKU_NODE_PEER_ID || 'PEER_ID';

    let wakuClient: any;
    let chatInstance: HyperliquidChat | null = null;

    const getAssetUrl = (path: string) => {
      if (browser.runtime?.getURL) return browser.runtime.getURL(path);
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
          onMessageReceived: (message: any) => { if (chatInstance) chatInstance.handleNewMessage(message); },
          onHistoryLoaded: (messages: any[]) => { if (chatInstance) chatInstance.handleHistoryLoaded(messages); },
          onConnectionStatusChange: (connected: boolean) => { if (chatInstance) chatInstance.handleConnectionStatusChange(connected); },
        });
        const success = await wakuClient.initialize();
        if (success) console.log('Waku client initialized successfully');
        else console.error('Failed to initialize Waku client');
      } catch (error) {
        console.error('Failed to initialize Waku:', error);
      } finally {
        initializeChat();
      }
    }

    function initializeChat() {
      chatInstance = new HyperliquidChat({ extensionAPI: browser });
      chatInstance.wakuClient = wakuClient;
      chatInstance.init();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { initializeWaku(); });
    else initializeWaku();
  },
});
