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
