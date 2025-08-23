// Background service worker
chrome.runtime.onInstalled.addListener(async () => {
  console.log("Hyperliquid Chat extension installed")

  // Get current mode from storage or default to sidepanel
  const result = await chrome.storage.local.get(['chatMode'])
  const currentMode = result.chatMode || 'sidepanel'

  // Set initial behavior and context menu title
  if (currentMode === 'sidepanel') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error)
    chrome.contextMenus.create({
      id: 'toggleChatMode',
      title: 'Switch to floating mode',
      contexts: ['action']
    })
  } else {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error)
    chrome.contextMenus.create({
      id: 'toggleChatMode',
      title: 'Switch to side panel mode',
      contexts: ['action']
    })
  }
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
        chrome.tabs.sendMessage(tab.id, request)
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

  // Handle popup UI mode requests
  if (request.action === 'getUIMode') {
    chrome.storage.local.get(['chatMode'], (result) => {
      const mode = result.chatMode || 'sidepanel'
      sendResponse({ mode: mode })
    })
    return true
  }

  if (request.action === 'toggleUIMode') {
    chrome.storage.local.get(['chatMode'], async (result) => {
      const currentMode = result.chatMode || 'sidepanel'
      const newMode = currentMode === 'sidepanel' ? 'floating' : 'sidepanel'

      await chrome.storage.local.set({ chatMode: newMode })

            // Update side panel behavior and switch modes
      if (newMode === 'sidepanel') {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error)
        chrome.contextMenus.update('toggleChatMode', { title: 'Switch to floating mode' })
        
        // Hide floating chat on all tabs with Hyperliquid and set side panel path
        chrome.tabs.query({ url: "*://app.hyperliquid.xyz/*" }, (tabs) => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, { action: 'hideChat' }).catch(() => {
              // Tab might not have content script loaded, that's OK
            })
            
            // Get room info and set side panel path for each tab
            chrome.tabs.sendMessage(tab.id, { action: 'getCurrentRoom' }, (response) => {
              if (response && response.pair && response.market) {
                chrome.sidePanel.setOptions({
                  tabId: tab.id,
                  path: `sidepanel.html?pair=${encodeURIComponent(response.pair)}&market=${encodeURIComponent(response.market)}`,
                  enabled: true
                }).catch(console.error)
              }
            })
          })
        })
      } else {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error)
        chrome.contextMenus.update('toggleChatMode', { title: 'Switch to side panel mode' })
        
        // Send message to close side panel when switching to floating mode
        chrome.runtime.sendMessage({ action: 'closeSidePanel' }).catch(() => {
          // Side panel might not be open, that's OK
        })
      }

      sendResponse({ mode: newMode })
    })
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
      // Switch to floating mode: close side panel and open floating chat
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error)
      chrome.contextMenus.update('toggleChatMode', { title: 'Switch to side panel mode' })
      
      // Send message to close side panel
      chrome.runtime.sendMessage({ action: 'closeSidePanel' }).catch(() => {
        // Side panel might not be open, that's OK
      })
      
      // Open floating chat if on Hyperliquid page
      if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
        chrome.tabs.sendMessage(tab.id, { action: 'showChat' })
      } else {
        chrome.tabs.create({ url: 'https://app.hyperliquid.xyz/trade' })
      }
        } else {
      // Switch to side panel mode: hide floating chat and open side panel
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error)
      chrome.contextMenus.update('toggleChatMode', { title: 'Switch to floating mode' })
      
      // Hide floating chat on current tab and get room info
      if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
        chrome.tabs.sendMessage(tab.id, { action: 'hideChat' }).catch(() => {
          // Tab might not have content script loaded, that's OK
        })
        
        // Get current room info from content script and set side panel path
        chrome.tabs.sendMessage(tab.id, { action: 'getCurrentRoom' }, (response) => {
          if (response && response.pair && response.market) {
            chrome.sidePanel.setOptions({
              tabId: tab.id,
              path: `sidepanel.html?pair=${encodeURIComponent(response.pair)}&market=${encodeURIComponent(response.market)}`,
              enabled: true
            }).catch(console.error)
          } else {
            // Fallback to default room
            chrome.sidePanel.setOptions({
              tabId: tab.id,
              path: `sidepanel.html?pair=UNKNOWN&market=Perps`,
              enabled: true
            }).catch(console.error)
          }
          
          // Open side panel after setting path
          chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(console.error)
        })
      } else {
        // Not on Hyperliquid page, open with default room
        chrome.sidePanel.setOptions({
          tabId: tab.id,
          path: `sidepanel.html?pair=UNKNOWN&market=Perps`,
          enabled: true
        }).catch(console.error)
        
        // Open side panel
        chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(console.error)
      }
    }
  }
})
