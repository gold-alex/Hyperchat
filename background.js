// Background service worker
chrome.runtime.onInstalled.addListener(() => {
  console.log("Hyperliquid Chat extension installed")
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
})
