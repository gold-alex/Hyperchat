// Background service worker
chrome.runtime.onInstalled.addListener(async () => {
  console.log("Hyperliquid Chat extension installed")
  
  // Enable side panel to open on action click
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error)
})

// Handle extension icon click - sidepanel mode is handled by setPanelBehavior
chrome.action.onClicked.addListener(async (tab) => {
  console.log("Extension icon clicked - sidepanel will open automatically")
  // Sidepanel opens automatically via setPanelBehavior
})

// Handle messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getStoredData") {
    chrome.storage.local.get([request.key], (result) => {
      sendResponse(result[request.key])
    })
    return true
  }

  if (request.action === "setStoredData") {
    chrome.storage.local.set({ [request.key]: request.value }, () => {
      sendResponse({ success: true })
    })
    return true
  }


  if (request.action === 'roomChange' || request.action === 'showChat') {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, request).catch(() => {})
      })
    })
    if (sender && sender.tab && sender.tab.id) {
      chrome.sidePanel.setOptions({
        tabId: sender.tab.id,
        path: `sidepanel.html?pair=${encodeURIComponent(request.pair || 'UNKNOWN')}&market=${encodeURIComponent(request.market || 'Perps')}`,
        enabled: true
      }).catch(console.error)
    }
    sendResponse({success:true})
    return true
  }
  
  if (request.action === 'syncSidepanel') {
    // Forward sync message to sidepanel
    chrome.runtime.sendMessage(request).catch(() => {
      // Sidepanel might not be open
    })
    sendResponse({success:true})
    return true
  }

})

