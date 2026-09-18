// Content script for Hyperliquid trading pages.
//
// This used to hold a second copy of the chat - its own Supabase client, its own
// message array, its own realtime channel - kept loosely in sync with the side
// panel's copy. That duplication was most of the old instability, so it is gone.
//
// What is left is the only work that genuinely has to happen on the page:
//
//   1. read which market is on screen, and notice when it changes
//   2. reach window.ethereum, which is only reachable from here
//   3. scroll to a panel when someone clicks an #element link
//
// The side panel owns the network, the room, and the messages.

const HYPERCHAT_STATE = {
  currentPair: '',
  currentMarket: '',
  walletAddress: '',
}

// --- page context bridges -------------------------------------------------

function injectScript(file) {
  const script = document.createElement('script')
  script.src = chrome.runtime.getURL(file)
  script.type = 'text/javascript'
  script.async = false
  ;(document.head || document.documentElement).appendChild(script)
  return script
}

function injectWalletBridge() {
  const script = injectScript('wallet-bridge.js')
  script.remove()
}

function injectElementLinks() {
  // Left in place: it defines window.ElementLinks for the page.
  injectScript('links-config-global.js')
}

// Round trip to the bridge running in page context.
function askBridge(requestType, responseType, payload) {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.random()

    const handler = (event) => {
      if (event.source !== window || !event.data) return
      if (event.data.type !== responseType || event.data.id !== id) return

      window.removeEventListener('message', handler)
      if (event.data.error) reject(new Error(event.data.error))
      else resolve(event.data)
    }

    window.addEventListener('message', handler)
    window.postMessage({ type: requestType, id, ...payload }, '*')

    setTimeout(() => {
      window.removeEventListener('message', handler)
      reject(new Error('Wallet did not respond'))
    }, 120000)
  })
}

async function connectWallet() {
  const response = await askBridge('HL_CONNECT_WALLET_REQUEST', 'HL_CONNECT_WALLET_RESPONSE', {})
  const accounts = response.accounts || []
  if (accounts.length === 0) throw new Error('No accounts returned. Unlock your wallet and try again.')

  HYPERCHAT_STATE.walletAddress = accounts[0]
  return accounts[0]
}

// The panel builds the typed data and derives the key; this only holds the pen.
async function signTypedData(typedData) {
  const response = await askBridge('HL_SIGN_REQUEST', 'HL_SIGN_RESPONSE', {
    typedData,
    address: HYPERCHAT_STATE.walletAddress,
  })
  return response.signature
}

// --- market detection -----------------------------------------------------

// Hyperliquid renders the leverage badge, and on first load a welcome banner,
// inside the same subtree as the pair name. Taking textContent wholesale yields
// things like "HYPE-USDC10x", which is a DIFFERENT room from "HYPE-USDC" - so the
// layout changing silently moved traders into an empty room.
//
// Pull the pair out by shape instead of trusting the node to contain only it.
// Lowercase is allowed because of the k-prefixed markets (kPEPE-USD); roomTag
// upper-cases for the tag, so casing never splits a room.
const PAIR_PATTERN = /([A-Za-z0-9]{1,15}[-/]USD[C]?)/

function normalizePair(text) {
  if (!text) return null
  const match = String(text).match(PAIR_PATTERN)
  return match ? match[1] : null
}

function detectMarketInfo() {
  // Standalone chat window: the market came in on the URL.
  if (window.CHAT_PAIR_OVERRIDE) {
    HYPERCHAT_STATE.currentPair = window.CHAT_PAIR_OVERRIDE
    HYPERCHAT_STATE.currentMarket = window.CHAT_MARKET_OVERRIDE || 'Perps'
    return
  }

  let pairElement = document.querySelector(
    '#coinInfo > div > div:nth-child(2) > div:nth-child(1) > div > div > div > div:nth-child(2) > div',
  )

  if (!pairElement || !pairElement.textContent.trim()) {
    pairElement = document.querySelector(
      '#root > div:nth-child(2) > div:nth-child(3) > div > div:nth-child(1) > div:nth-child(1) > div > div:nth-child(1) > div > div > div > div:nth-child(2) > div',
    )
  }

  // Fall back to finding the coin icon and reading the label beside it.
  if (!pairElement || !pairElement.textContent.trim()) {
    const coinIcon = document.querySelector('img[alt][src*="/coins/"]')
    if (coinIcon) {
      const container = coinIcon.closest('div[style*="display"]')
      if (container && container.parentElement) {
        // Prefer the most specific match. The outermost container also contains
        // the pair, but wrapped in everything else on the page.
        let best = null
        for (const element of container.parentElement.querySelectorAll('div')) {
          if (!normalizePair(element.textContent)) continue
          const length = element.textContent.trim().length
          if (!best || length < best.length) best = { element, length }
        }
        if (best) pairElement = best.element
      }
    }
  }

  if (!pairElement || !pairElement.textContent.trim()) {
    pairElement =
      document.querySelector('.sc-bjfHbI.bFBYgR') ||
      document.querySelector("[data-testid='trading-pair']") ||
      document.querySelector('.trading-pair')
  }

  if (pairElement) {
    const newPair = normalizePair(pairElement.textContent)
    if (newPair && newPair !== HYPERCHAT_STATE.currentPair) {
      HYPERCHAT_STATE.currentPair = newPair
    }
  }

  const spotElement = document.querySelector(
    'div[style*="background: rgb(7, 39, 35)"] .sc-bjfHbI.jxtURp.body12Regular',
  )
  HYPERCHAT_STATE.currentMarket =
    spotElement && spotElement.textContent.includes('Spot') ? 'Spot' : 'Perps'

  if (!HYPERCHAT_STATE.currentPair) HYPERCHAT_STATE.currentPair = 'UNKNOWN'
}

function startMarketMonitoring() {
  let lastRoom = `${HYPERCHAT_STATE.currentPair}_${HYPERCHAT_STATE.currentMarket}`

  setInterval(() => {
    detectMarketInfo()
    const room = `${HYPERCHAT_STATE.currentPair}_${HYPERCHAT_STATE.currentMarket}`
    if (room === lastRoom) return

    lastRoom = room
    chrome.runtime
      .sendMessage({
        action: 'roomChange',
        pair: HYPERCHAT_STATE.currentPair,
        market: HYPERCHAT_STATE.currentMarket,
      })
      .catch(() => {
        // Nothing listening yet; the panel polls for the room anyway.
      })
  }, 2000)
}

// --- element links --------------------------------------------------------

// Supports the ":contains('...')" pseudo-selector used by links-config, which the
// browser does not implement.
function findByContains(selector) {
  const match = selector.match(/^(.+?):contains\(['"](.+?)['"]\)$/)
  if (!match) return null

  const [, baseSelector, searchText] = match
  let best = null
  let smallest = Infinity

  for (const candidate of document.querySelectorAll(baseSelector)) {
    if (!(candidate.textContent || '').toLowerCase().includes(searchText.toLowerCase())) continue

    // Prefer the smallest matching element: the biggest one is usually the whole page.
    const rect = candidate.getBoundingClientRect()
    const size = rect.width * rect.height
    if (size > 0 && size < smallest && size < 100000) {
      smallest = size
      best = candidate
    }
  }

  return best
}

function scrollToElement(selector) {
  if (!selector) return

  let element = null

  if (selector.startsWith('#')) {
    element = document.getElementById(selector.substring(1))
  } else {
    try {
      element = document.querySelector(selector)
    } catch {
      element = null
    }
    if (!element && selector.includes(':contains(')) element = findByContains(selector)
  }

  if (!element) return

  element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  element.classList.add('hl-element-highlight')
  setTimeout(() => element.classList.remove('hl-element-highlight'), 2000)
}

// --- side panel interface -------------------------------------------------

function setupMessageListener() {
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    switch (request.action) {
      case 'getCurrentRoom':
        sendResponse({
          pair: HYPERCHAT_STATE.currentPair,
          market: HYPERCHAT_STATE.currentMarket,
          walletAddress: HYPERCHAT_STATE.walletAddress,
        })
        return true

      case 'connectWallet':
        connectWallet()
          .then((address) => sendResponse({ address }))
          .catch((error) => sendResponse({ error: error.message }))
        return true

      case 'signTypedData':
        signTypedData(request.typedData)
          .then((signature) => sendResponse({ signature }))
          .catch((error) => sendResponse({ error: error.message }))
        return true

      case 'forgetWallet':
        HYPERCHAT_STATE.walletAddress = ''
        sendResponse({ ok: true })
        return true

      case 'scrollToElement':
        scrollToElement(request.elementSelector || request.elementId)
        sendResponse({ ok: true })
        return true

      case 'roomChange':
        // Standalone chat window following the trade tab.
        if (window.IS_STANDALONE_CHAT && request.pair) {
          HYPERCHAT_STATE.currentPair = request.pair
          HYPERCHAT_STATE.currentMarket = request.market || 'Perps'
          window.CHAT_PAIR_OVERRIDE = request.pair
          window.CHAT_MARKET_OVERRIDE = request.market
        }
        return false

      default:
        return false
    }
  })
}

function init() {
  injectWalletBridge()
  injectElementLinks()
  detectMarketInfo()
  setupMessageListener()
  startMarketMonitoring()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

export { detectMarketInfo, normalizePair, scrollToElement, findByContains, HYPERCHAT_STATE }
