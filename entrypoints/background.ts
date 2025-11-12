import { defineBackground } from 'wxt/sandbox';
import { browser } from 'wxt/browser';
import type { Message } from '../src/messages';

export default defineBackground(() => {
  const hasSidePanel = () => (browser as any).sidePanel && typeof (browser as any).sidePanel.setPanelBehavior === 'function';
  // Background service worker (migrated from background.js)
  browser.runtime.onInstalled.addListener(async () => {
    console.log('Hyperliquid Chat extension installed');
    await browser.storage.local.set({ chatMode: 'sidepanel' });
    if (hasSidePanel()) {
      // @ts-ignore - Chrome-only API
      (browser as any).sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
    }
    browser.contextMenus.create({ id: 'toggleChatMode', title: 'Switch to floating mode', contexts: ['action'] });
  });

  browser.action.onClicked.addListener(async (tab: any) => {
    console.log('Extension icon clicked');
    const result = await browser.storage.local.get(['chatMode']);
    const currentMode = (result as any).chatMode || 'sidepanel';
    if (currentMode === 'floating') {
      if (tab.url && tab.url.includes('app.hyperliquid.xyz/trade')) {
        await browser.tabs.sendMessage(tab.id!, { action: 'showChat' } as Message).catch(() => { console.log('Content script not ready'); });
      } else {
        await browser.tabs.update(tab.id!, { url: 'https://app.hyperliquid.xyz/trade' });
        await new Promise<void>((resolve) => {
          const listener = (tabId: number, info: any) => {
            if (tabId === tab.id && info.status === 'complete') {
              browser.tabs.onUpdated.removeListener(listener as any);
              setTimeout(resolve, 1000);
            }
          };
          browser.tabs.onUpdated.addListener(listener as any);
          setTimeout(resolve, 5000);
        });
        await browser.tabs.sendMessage(tab.id!, { action: 'showChat' } as Message).catch(() => { console.log('Content script not ready yet'); });
      }
    }
  });

  browser.runtime.onMessage.addListener(async (request: Message, sender) => {
    if (request.action === 'getStoredData') {
      const result = await browser.storage.local.get([(request as any).key]);
      return (result as any)[(request as any).key];
    }
    if (request.action === 'setStoredData') {
      await browser.storage.local.set({ [(request as any).key]: (request as any).value });
      return { success: true };
    }
    if (request.action === 'openStandaloneChat') {
      const url = chrome.runtime.getURL(`chat-widget.html?pair=${encodeURIComponent((request as any).pair || 'UNKNOWN')}&market=${encodeURIComponent((request as any).market || 'Perps')}`);
      await browser.tabs.create({ url });
      return { success: true };
    }
    if (request.action === 'roomChange' || request.action === 'showChat') {
      const tabs = await browser.tabs.query({ url: '*://app.hyperliquid.xyz/*' });
      for (const t of tabs) {
        await browser.tabs.sendMessage(t.id!, request).catch(() => {});
      }
      if (sender && sender.tab && sender.tab.id && hasSidePanel()) {
        // @ts-ignore
        await (browser as any).sidePanel.setOptions({
          tabId: sender.tab.id,
          path: `sidepanel.html?pair=${encodeURIComponent((request as any).pair || 'UNKNOWN')}&market=${encodeURIComponent((request as any).market || 'Perps')}`,
          enabled: true,
        }).catch(console.error);
      }
      return { success: true };
    }
    if (request.action === 'syncSidepanel') {
      await browser.runtime.sendMessage(request).catch(() => {});
      return { success: true };
    }
    return undefined as any;
  });

  browser.contextMenus.onClicked.addListener(async (info: any, tab: any) => {
    if (info.menuItemId === 'toggleChatMode') {
      const result = await browser.storage.local.get(['chatMode']);
      const currentMode = (result as any).chatMode || 'sidepanel';
      const newMode = currentMode === 'sidepanel' ? 'floating' : 'sidepanel';
      await browser.storage.local.set({ chatMode: newMode });
      if (newMode === 'floating') {
        browser.contextMenus.update('toggleChatMode', { title: 'Switch to side panel mode' });
        if (hasSidePanel()) {
          // @ts-ignore
          (browser as any).sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
        }
        await browser.runtime.sendMessage({ action: 'closeSidePanel' } as Message).catch(() => {});
        if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
          await browser.tabs.sendMessage(tab.id!, { action: 'showChat' } as Message).catch(() => {});
        }
      } else {
        browser.contextMenus.update('toggleChatMode', { title: 'Switch to floating mode' });
        if (hasSidePanel()) {
          // @ts-ignore
          (browser as any).sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
          if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz/trade')) {
            // @ts-ignore
            await (browser as any).sidePanel.setOptions({ tabId: tab.id!, path: `sidepanel.html?pair=UNKNOWN&market=Perps`, enabled: true });
            // @ts-ignore
            await (browser as any).sidePanel.open({ tabId: tab.id! }).catch(console.error);
          }
        }
        const tabs = await browser.tabs.query({ url: '*://app.hyperliquid.xyz/*' });
        for (const hlTab of tabs) {
          await browser.tabs.sendMessage(hlTab.id!, { action: 'hideChat' } as Message).catch(() => {});
          if (hlTab.url && hlTab.url.includes('app.hyperliquid.xyz/trade') && (!tab || hlTab.id !== tab.id)) {
            try {
              const response: any = await browser.tabs.sendMessage(hlTab.id!, { action: 'getCurrentRoom' } as Message).catch(() => null);
              const pair = response?.pair || 'UNKNOWN';
              const market = response?.market || 'Perps';
              if (hasSidePanel()) {
                // @ts-ignore
                await (browser as any).sidePanel.setOptions({
                  tabId: hlTab.id!,
                  path: `sidepanel.html?pair=${encodeURIComponent(pair)}&market=${encodeURIComponent(market)}`,
                  enabled: true,
                });
              }
            } catch (error) {
              console.error('Error setting up side panel:', error);
            }
          }
        }
      }
    }
  });
});
