// Background service worker
chrome.runtime.onInstalled.addListener(() => {
  console.log("Hyperliquid Chat extension installed")
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error)

  // Create context menu for floating chat
  chrome.contextMenus.create({
    id: 'openFloatingChat',
    title: 'Open floating chat',
    contexts: ['action']
  })

  chrome.contextMenus.create({
    id: 'toggleChatMode',
    title: 'Switch to popup mode',
    contexts: ['action']
  })
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
})

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'openFloatingChat') {
    if (tab && tab.url && tab.url.includes('app.hyperliquid.xyz')) {
      chrome.tabs.sendMessage(tab.id, { action: 'showChat' })
    } else {
      chrome.tabs.create({ url: 'https://app.hyperliquid.xyz/trade' })
    }
  } else if (info.menuItemId === 'toggleChatMode') {
    // Get current mode from storage
    const result = await chrome.storage.local.get(['chatMode'])
    const currentMode = result.chatMode || 'sidepanel'
    const newMode = currentMode === 'sidepanel' ? 'popup' : 'sidepanel'

    // Save new mode
    await chrome.storage.local.set({ chatMode: newMode })

    // Update behavior
    if (newMode === 'popup') {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error)
      chrome.contextMenus.update('toggleChatMode', { title: 'Switch to side panel mode' })
    } else {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error)
      chrome.contextMenus.update('toggleChatMode', { title: 'Switch to popup mode' })
    }
  }
})
