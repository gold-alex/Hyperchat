// Popup script for the Chrome extension
document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("popup-root")

  root.innerHTML = `
    <div style="padding: 16px; text-align: center;">
      <div style="color: #50d2c1; font-size: 18px; font-weight: bold; margin-bottom: 16px;">
        Hyperliquid Chat
      </div>
      <div style="margin-bottom: 16px; font-size: 14px; color: #a0a0a0;">
        Navigate to app.hyperliquid.xyz/trade to start chatting
      </div>
      <div id="modeRow" style="margin-bottom: 10px; font-size: 12px; color: #cfeee8;">
        Mode: <span id="modeLabel">…</span>
      </div>
      <button id="toggleMode" style="
        background: transparent;
        color: #50d2c1;
        border: 1px solid #50d2c1;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
        margin-bottom: 12px;
      ">
        Switch to Popup
      </button>
      <button id="openChat" style="
        background: #50d2c1;
        color: #0a1f1c;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
      ">
        Open Chat
      </button>
    </div>
  `

  // Initialize UI mode state
  chrome.runtime.sendMessage({ action: 'getUIMode' }, (resp) => {
    const mode = resp?.mode || 'sidepanel'
    const label = document.getElementById('modeLabel')
    const btn = document.getElementById('toggleMode')
    if (label) label.textContent = mode
    if (btn) btn.textContent = mode === 'sidepanel' ? 'Switch to Popup' : 'Switch to Sidepanel'
  })

  document.getElementById('toggleMode').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'toggleUIMode' }, (resp) => {
      const mode = resp?.mode || 'sidepanel'
      const label = document.getElementById('modeLabel')
      const btn = document.getElementById('toggleMode')
      if (label) label.textContent = mode
      if (btn) btn.textContent = mode === 'sidepanel' ? 'Switch to Popup' : 'Switch to Sidepanel'
    })
  })

  document.getElementById("openChat").addEventListener("click", () => {
    window.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0].url.includes("app.hyperliquid.xyz/trade")) {
        window.chrome.tabs.sendMessage(tabs[0].id, { action: "toggleChat" })
        window.close()
      } else {
        window.chrome.tabs.create({ url: "https://app.hyperliquid.xyz/trade" })
      }
    })
  })
})
