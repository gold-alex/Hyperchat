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
      <div style="display: flex; gap: 8px; flex-direction: column;">
        <button id="openChat" style="
          background: #50d2c1;
          color: #0a1f1c;
          border: none;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
          font-weight: bold;
        ">
          Open Floating Chat
        </button>
        <button id="openSidePanel" style="
          background: #072723;
          color: #50d2c1;
          border: 1px solid #50d2c1;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
          font-weight: bold;
        ">
          Open Side Panel
        </button>
      </div>
    </div>
  `

  function updateUIModeDisplay(mode) {
    const label = document.getElementById('modeLabel');
    const btn = document.getElementById('toggleMode');
    if (label && btn) {
        const isSidePanel = mode === 'sidepanel';
        label.textContent = isSidePanel ? 'Current Mode: Side Panel' : 'Current Mode: Popup';
        btn.textContent = isSidePanel ? 'Switch to Popup Mode' : 'Switch to Side Panel Mode';
    }
  }

  // Initialize UI mode state
  chrome.runtime.sendMessage({ action: 'getUIMode' }, (resp) => {
    if (resp && resp.mode) {
        updateUIModeDisplay(resp.mode);
    }
  })

  document.getElementById('toggleMode').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'toggleUIMode' }, (resp) => {
      if (resp && resp.mode) {
        updateUIModeDisplay(resp.mode);

        // If switching to sidepanel mode, close the popup
        if (resp.mode === 'sidepanel') {
          console.log('Switching to sidepanel mode, closing popup');
          window.close();
        }
      }
    })
  })

  document.getElementById("openChat").addEventListener("click", () => {
    // Check if we have stored pair/market info from a previous sidepanel session
    chrome.storage.local.get(['currentPair', 'currentMarket'], (result) => {
      const pair = result.currentPair
      const market = result.currentMarket

      if (pair && market) {
        // We have stored market info from sidepanel, use it for popup
        // Create a popup version of the chat widget
        const popupWindow = window.open(
          chrome.runtime.getURL(`chat-widget.html?pair=${encodeURIComponent(pair)}&market=${encodeURIComponent(market)}`),
          'hlChatPopup',
          'width=400,height=600,top=100,left=100,resizable=yes,scrollbars=yes'
        )

        if (popupWindow) {
          // Focus the new window
          popupWindow.focus()
          // Close the extension popup
          window.close()
        } else {
          // Popup blocked, fallback to tab
          chrome.tabs.create({
            url: chrome.runtime.getURL(`chat-widget.html?pair=${encodeURIComponent(pair)}&market=${encodeURIComponent(market)}`)
          })
          window.close()
        }
      } else {
        // No stored info, use the normal flow
        window.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0] && tabs[0].url && tabs[0].url.includes("app.hyperliquid.xyz/trade")) {
            window.chrome.tabs.sendMessage(tabs[0].id, { action: "toggleChat" })
            window.close()
          } else {
            window.chrome.tabs.create({ url: "https://app.hyperliquid.xyz/trade" })
          }
        })
      }
    })
  })

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

  // Listen for live updates from the background script
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'uiModeChanged') {
      updateUIModeDisplay(request.newMode);
    }
  });
})
