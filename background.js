// Background service worker
const connectedTabs = new Set()
const UIMODE_KEY = 'uiMode'

function applyUIMode(mode) {
  const openPanel = mode === 'sidepanel'
  console.log('[BG] applyUIMode', { mode, openPanel })
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: openPanel }).catch((e)=>{
    console.warn('[BG] setPanelBehavior error', e?.message || e)
  })
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[BG] Hyperliquid Chat extension installed')
  chrome.storage.local.get([UIMODE_KEY], (result) => {
    const mode = result[UIMODE_KEY] || 'sidepanel'
    if (!result[UIMODE_KEY]) {
      chrome.storage.local.set({ [UIMODE_KEY]: mode })
    }
    applyUIMode(mode)
  })
})

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get([UIMODE_KEY], (result) => {
    const mode = result[UIMODE_KEY] || 'sidepanel'
    applyUIMode(mode)
  })
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'hl-content') {
    const tabId = port.sender && port.sender.tab && port.sender.tab.id
    console.log('[BG] onConnect hl-content', { tabId })
    if (tabId) connectedTabs.add(tabId)
    console.log('[BG] connectedTabs size', connectedTabs.size, Array.from(connectedTabs))
    port.onDisconnect.addListener(() => {
      console.log('[BG] onDisconnect hl-content', { tabId })
      if (tabId) connectedTabs.delete(tabId)
      console.log('[BG] connectedTabs size', connectedTabs.size, Array.from(connectedTabs))
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

  if (request.action === 'getUIMode') {
    console.log('[BG] getUIMode')
    chrome.storage.local.get([UIMODE_KEY], (result) => {
      sendResponse({ mode: result[UIMODE_KEY] || 'sidepanel' })
    })
    return true
  }

  if (request.action === 'setUIMode' && (request.mode === 'sidepanel' || request.mode === 'popup')) {
    console.log('[BG] setUIMode', { mode: request.mode })
    chrome.storage.local.set({ [UIMODE_KEY]: request.mode }, () => {
      applyUIMode(request.mode)
      sendResponse({ success: true, mode: request.mode })
    })
    return true
  }

  if (request.action === 'toggleUIMode') {
    console.log('[BG] toggleUIMode')
    chrome.storage.local.get([UIMODE_KEY], (result) => {
      const current = result[UIMODE_KEY] || 'sidepanel'
      const next = current === 'sidepanel' ? 'popup' : 'sidepanel'
      chrome.storage.local.set({ [UIMODE_KEY]: next }, () => {
        applyUIMode(next)
        sendResponse({ success: true, mode: next })
      })
    })
    return true
  }
  
  if (request.action === 'switchToPopupMode') {
    console.log('[BG] switchToPopupMode')

    // Store the current pair/market for the popup to use
    chrome.storage.local.set({
      currentPair: request.pair || 'UNKNOWN',
      currentMarket: request.market || 'Perps',
      [UIMODE_KEY]: 'popup'
    }, () => {
      // Apply UI mode setting to use popup
      applyUIMode('popup')

      // No need for notification - user will click the extension icon

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

  if (request.action === 'getCurrentMarketInfo') {
    console.log('[BG] getCurrentMarketInfo')
    chrome.tabs.query({ url: 'https://app.hyperliquid.xyz/*' }, (tabs) => {
      const targetTab = tabs.find(t => t.active) || tabs[0]
      if (!targetTab?.id) {
        sendResponse({ error: 'No Hyperliquid tab found' })
        return
      }
      chrome.tabs.sendMessage(targetTab.id, { action: 'getMarketInfo' }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          console.warn('[BG] getCurrentMarketInfo failed', chrome.runtime.lastError?.message)
          sendResponse({ error: 'Failed to get market info' })
        } else {
          console.log('[BG] getCurrentMarketInfo response', resp)
          sendResponse(resp)
        }
      })
    })
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
        path: `chat-widget.html?pair=${encodeURIComponent(request.pair || 'UNKNOWN')}&market=${encodeURIComponent(request.market || 'Perps')}`,
        enabled: true
      }).catch(console.error)
    }
    sendResponse({success:true})
    return true
  }

  // Proxy wallet requests coming from side panel to a Hyperliquid trade tab
  if (request.action === 'proxyRequestAccounts') {
    console.log('[BG] proxyRequestAccounts start', { connectedTabs: Array.from(connectedTabs) })
    // Prefer any tab that has established a live port connection
    const connected = Array.from(connectedTabs)
    const tryTabId = connected.length > 0 ? connected[0] : null
    const withTabs = (targetTabId) => {
      console.log('[BG] proxyRequestAccounts withTabs', { targetTabId })
      if (!targetTabId) {
        sendResponse({ error: 'Open a Hyperliquid Trade tab to connect wallet' })
        return
      }
      const sendToTab = (attempt = 1) => {
        console.log('[BG] proxyRequestAccounts sendToTab attempt', { attempt, targetTabId })
        chrome.tabs.sendMessage(targetTabId, { action: 'doRequestAccounts' }, (resp) => {
          if (chrome.runtime.lastError || !resp) {
            const lastErr = chrome.runtime.lastError && chrome.runtime.lastError.message
            console.warn('[BG] proxyRequestAccounts sendMessage error', { attempt, lastErr, respPresent: !!resp })
            if (attempt < 3) {
              chrome.scripting.executeScript({ target: { tabId: targetTabId }, files: ['content.js'] }, () => {
                const injErr = chrome.runtime.lastError && chrome.runtime.lastError.message
                if (injErr) console.warn('[BG] executeScript error', injErr)
                setTimeout(() => sendToTab(attempt + 1), 300)
              })
              return
            }
            sendResponse({ error: lastErr || 'No receiver in trade tab' })
            return
          }
          console.log('[BG] proxyRequestAccounts response', resp)
          sendResponse(resp)
        })
      }
      sendToTab(1)
    }

    if (tryTabId) {
      withTabs(tryTabId)
    } else {
      // Fallback: search tabs by URL
      chrome.tabs.query({ url: 'https://app.hyperliquid.xyz/*' }, (tabs) => {
        console.log('[BG] proxyRequestAccounts fallback tabs', tabs.map(t=>({id:t.id, active:t.active, url:t.url})))
        const targetTab = tabs.find(t => t.active) || tabs[0]
        const id = targetTab && targetTab.id
        if (id) {
          withTabs(id)
        } else {
          console.log('[BG] proxyRequestAccounts no tabs found, opening trade tab')
          chrome.tabs.create({ url: 'https://app.hyperliquid.xyz/trade' }, (newTab) => {
            const newId = newTab && newTab.id
            let attempts = 0
            const waitForConnect = () => {
              attempts += 1
              console.log('[BG] waiting for content connect', { attempts, newId })
              if (connectedTabs.has(newId)) {
                withTabs(newId)
                return
              }
              if (attempts >= 10) {
                sendResponse({ error: 'Timed out waiting for Hyperliquid Trade tab' })
                return
              }
              setTimeout(waitForConnect, 300)
            }
            waitForConnect()
          })
        }
      })
    }
    return true
  }

  if (request.action === 'proxySignMessage') {
    console.log('[BG] proxySignMessage start', { connectedTabs: Array.from(connectedTabs) })
    const connected = Array.from(connectedTabs)
    const tryTabId = connected.length > 0 ? connected[0] : null
    const withTabs = (targetTabId) => {
      console.log('[BG] proxySignMessage withTabs', { targetTabId })
      if (!targetTabId) {
        sendResponse({ error: 'Open a Hyperliquid Trade tab to sign' })
        return
      }
      const sendToTab = (attempt = 1) => {
        console.log('[BG] proxySignMessage sendToTab attempt', { attempt, targetTabId })
        chrome.tabs.sendMessage(targetTabId, { action: 'doSignMessage', message: request.message }, (resp) => {
          if (chrome.runtime.lastError || !resp) {
            const lastErr = chrome.runtime.lastError && chrome.runtime.lastError.message
            console.warn('[BG] proxySignMessage sendMessage error', { attempt, lastErr, respPresent: !!resp })
            if (attempt < 3) {
              chrome.scripting.executeScript({ target: { tabId: targetTabId }, files: ['content.js'] }, () => {
                const injErr = chrome.runtime.lastError && chrome.runtime.lastError.message
                if (injErr) console.warn('[BG] executeScript error', injErr)
                setTimeout(() => sendToTab(attempt + 1), 300)
              })
              return
            }
            sendResponse({ error: lastErr || 'No receiver in trade tab for signing' })
            return
          }
          console.log('[BG] proxySignMessage response', resp)
          sendResponse(resp)
        })
      }
      sendToTab(1)
    }

    if (tryTabId) {
      withTabs(tryTabId)
    } else {
      chrome.tabs.query({ url: 'https://app.hyperliquid.xyz/*' }, (tabs) => {
        console.log('[BG] proxySignMessage fallback tabs', tabs.map(t=>({id:t.id, active:t.active, url:t.url})))
        const targetTab = tabs.find(t => t.active) || tabs[0]
        const id = targetTab && targetTab.id
        if (id) {
          withTabs(id)
        } else {
          console.log('[BG] proxySignMessage no tabs found, opening trade tab')
          chrome.tabs.create({ url: 'https://app.hyperliquid.xyz/trade' }, (newTab) => {
            const newId = newTab && newTab.id
            let attempts = 0
            const waitForConnect = () => {
              attempts += 1
              console.log('[BG] waiting for content connect (sign)', { attempts, newId })
              if (connectedTabs.has(newId)) {
                withTabs(newId)
                return
              }
              if (attempts >= 10) {
                sendResponse({ error: 'Timed out waiting for Hyperliquid Trade tab for signing' })
                return
              }
              setTimeout(waitForConnect, 300)
            }
            waitForConnect()
          })
        }
      })
    }
    return true
  }
})
