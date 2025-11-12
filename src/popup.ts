export function initPopup() {
  const root = document.getElementById('popup-root');
  if (!root) return;

  // Simple inline UI similar to original popup
  root.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;padding:16px;background:#0a1f1c;color: #f6fefb;width:320px">
      <div style="font-weight:600;color: #50d2c1">Hyperliquid Chat</div>
      <div style="color: #a0a0a0">Navigate to app.hyperliquid.xyz/trade to start chatting</div>
      <button id="openChat" style="background:#50d2c1;color:#0a1f1c;border:none;padding:8px 12px;border-radius:6px;cursor:pointer">Open Chat</button>
    </div>
  `;

  const btn = document.getElementById('openChat');
  btn?.addEventListener('click', () => {
    try {
      // Query active tab
      // @ts-ignore
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs: any[]) => {
        const tab = tabs && tabs[0];
        const url = tab?.url || '';
        const isTrade = typeof url === 'string' && url.includes('app.hyperliquid.xyz/trade');
        if (isTrade) {
          // @ts-ignore
          chrome.tabs.sendMessage(tab.id, { action: 'toggleChat' });
          window.close();
        } else {
          // @ts-ignore
          chrome.tabs.create({ url: 'https://app.hyperliquid.xyz/trade' });
        }
      });
    } catch {
      // ignore in tests
    }
  });
}
