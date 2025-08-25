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
      <button id="openSidePanel" style="
        background: #50d2c1;
        color: #0a1f1c;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
      ">
        Open Side Panel
      </button>
    </div>
  `


  document.getElementById("openSidePanel").addEventListener("click", () => {
    chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).then(() => {
      window.close()
    }).catch(() => {
      // If side panel API not available, fallback to setting behavior
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).then(() => {
        alert('Side panel enabled! Click the extension icon to open it.')
        window.close()
      }).catch(console.error)
    })
  })
})
