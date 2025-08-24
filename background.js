// Background service worker
chrome.runtime.onInstalled.addListener(async () => {
  console.log("Hyperliquid Chat extension installed")

  // Default to sidepanel mode
  await chrome.storage.local.set({ chatMode: 'sidepanel' })
  
  // Enable side panel to open on action click
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error)
  
  // Create context menu for mode switching
  chrome.contextMenus.create({
    id: 'toggleChatMode',
    title: 'Switch to floating mode',
    contexts: ['action']
  })
})

// Handle extension icon click - only needed for floating mode
chrome.action.onClicked.addListener(async (tab) => {
  console.log("Extension icon clicked")
  
  // Get current mode
  const result = await chrome.storage.local.get(['chatMode'])
  const currentMode = result.chatMode || 'sidepanel'
  
  // Only handle clicks in floating mode
  // Sidebar mode is handled by setPanelBehavior and the sidebar itself will navigate
  if (currentMode === 'floating') {
    if (tab.url && tab.url.includes('app.hyperliquid.xyz/trade')) {
      // Show floating chat
      chrome.tabs.sendMessage(tab.id, { action: 'showChat' }).catch(() => {
        console.log("Content script not ready")
      })
    } else {
      // Navigate and show chat after
      chrome.tabs.update(tab.id, { url: 'https://app.hyperliquid.xyz/trade' }, (updatedTab) => {
        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener)
            setTimeout(() => {
              chrome.tabs.sendMessage(tab.id, { action: 'showChat' }).catch(() => {
                console.log("Content script not ready yet")
              })
            }, 1000)
          }
        })
      })
    }
  }
  // For sidebar mode, setPanelBehavior will open it and sidebar will handle navigation
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

  if (request.action === "openStandaloneChat") {
    const url = chrome.runtime.getURL(`chat-widget.html?pair=${encodeURIComponent(request.pair||'UNKNOWN')}&market=${encodeURIComponent(request.market||'Perps')}`)
    chrome.tabs.create({ url })
    sendResponse({ success: true })
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

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'toggleChatMode') {
    // Get current mode from storage
    const result = await chrome.storage.local.get(['chatMode'])
    const currentMode = result.chatMode || 'sidepanel'
    const newMode = currentMode === 'sidepanel' ? 'floating' : 'sidepanel'

    // Save new mode
    await chrome.storage.local.set({ chatMode: newMode })

    if (newMode === 'floating') {
      // Switch to floating mode
      chrome.contextMenus.update('toggleChatMode', { title: 'Switch to side panel mode' })
      
      // Disable auto-open side panel on action click
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error)
      
      // Send message to close side panel
      chrome.runtime.sendMessage({ action: 'closeSidePanel' }).catch(() => {
        // Side panel might not be open, that's OK
      })
      
      // Hide any open side panels and show floating chat
      if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
        // Show floating chat
        chrome.tabs.sendMessage(tab.id, { action: 'showChat' })
      }
    } else {
      // Switch to side panel mode
      chrome.contextMenus.update('toggleChatMode', { title: 'Switch to floating mode' })
      
      // Enable auto-open side panel on action click
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error)
      
      // First, open side panel for current tab immediately (while we have user gesture)
      if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz/trade')) {
        chrome.sidePanel.setOptions({
          tabId: tab.id,
          path: `sidepanel.html?pair=UNKNOWN&market=Perps`,
          enabled: true
        }).then(() => {
          // Open immediately while we have the user gesture
          chrome.sidePanel.open({ tabId: tab.id }).catch(console.error)
        })
      }
      
      // Hide floating chat on all Hyperliquid tabs
      chrome.tabs.query({ url: "*://app.hyperliquid.xyz/*" }, async (tabs) => {
        for (const hlTab of tabs) {
          // Hide floating chat
          chrome.tabs.sendMessage(hlTab.id, { action: 'hideChat' }).catch(() => {
            // Tab might not have content script loaded, that's OK
          })
          
          // Set up side panel for other tabs (but don't try to open them)
          if (hlTab.url && hlTab.url.includes('app.hyperliquid.xyz/trade') && hlTab.id !== tab.id) {
            try {
              // Try to get current room info
              const response = await chrome.tabs.sendMessage(hlTab.id, { action: 'getCurrentRoom' }).catch(() => null)
              const pair = response?.pair || 'UNKNOWN'
              const market = response?.market || 'Perps'
              
              await chrome.sidePanel.setOptions({
                tabId: hlTab.id,
                path: `sidepanel.html?pair=${encodeURIComponent(pair)}&market=${encodeURIComponent(market)}`,
                enabled: true
              })
            } catch (error) {
              console.error("Error setting up side panel:", error)
            }
          }
        }
      })
    }
  }
})
