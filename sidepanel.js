// Side panel: the whole chat client.
//
// It owns the relay connections, the room, the messages and sign-in. The content
// script only reports which market is on screen and holds the pen for the two
// wallet signatures, because window.ethereum is reachable only from the page.
//
// Sockets live here rather than in the service worker on purpose: MV3 workers idle
// out and would drop the connections underneath us.

import { HyperchatClient } from './lib/nostr/client.js'
import { roomTag } from './lib/nostr/config.js'
import {
  bindingTypedData,
  buildBindingEvent,
  clearIdentity,
  identityFromLoginSignature,
  loadIdentity,
  loginTypedData,
  normalizeAddress,
  saveIdentity,
} from './lib/nostr/identity.js'
import { fetchHlNames, verifyHlName } from './lib/nostr/names.js'
import PnLService from './pnl-service.js'
import { ELEMENT_LINK_CONFIG, processElementLinks } from './links-config.js'

const params = new URLSearchParams(location.search)

const state = {
  pair: params.get('pair') || '',
  market: params.get('market') || 'Perps',
  identity: null,
  availableNames: [],
  selectedName: '',
  autoScroll: true,
  relays: { connected: [], total: 0 },
  signingIn: false,
  uiReady: false,
}

const client = new HyperchatClient()
const pnlService = new PnLService()
const pnlCache = new Map()
let pnlPollTimer = null

// --- content script bridge ------------------------------------------------

async function callContentScript(message, { timeoutMs = 125000 } = {}) {
  const tabs = await chrome.tabs.query({ url: '*://app.hyperliquid.xyz/*' })
  if (!tabs || tabs.length === 0) {
    throw new Error('Open app.hyperliquid.xyz/trade first')
  }

  let lastError = new Error('Hyperliquid tab is not responding')

  for (const tab of tabs) {
    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(tab.id, message),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out')), timeoutMs)),
      ])
      if (response?.error) throw new Error(response.error)
      if (response) return response
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
}

async function syncRoomFromPage() {
  try {
    const response = await callContentScript({ action: 'getCurrentRoom' }, { timeoutMs: 3000 })
    if (!response?.pair || response.pair === 'UNKNOWN') return false

    const changed = response.pair !== state.pair || response.market !== state.market
    state.pair = response.pair
    state.market = response.market || 'Perps'

    if (changed || !state.uiReady) await enterRoom()
    return true
  } catch {
    return false
  }
}

// --- rooms ----------------------------------------------------------------

async function enterRoom() {
  if (!state.pair) return

  // Only tear down PnL when the room genuinely changes. This used to run
  // unconditionally and blank the message list, while joinRoom below early
  // returns for an unchanged room - so nothing ever refilled it and the panel
  // sat empty until the next inbound event.
  const changingRoom = client.room?.tag !== roomTag(state.pair, state.market)

  if (changingRoom) {
    pnlCache.clear()
    pnlService.clearCache()
    stopPnLPolling()
  }

  if (!state.uiReady) {
    state.uiReady = true
    renderShell()
  } else {
    updateChatHeader()
    renderMessages()
  }

  await client.joinRoom(state.pair, state.market)
  if (changingRoom) startPnLPolling()
}

// --- sign in --------------------------------------------------------------
//
// Two wallet popups, once per device, then never again: the first signature is
// hashed into the chat key and never leaves the machine, the second is published
// as proof that the key belongs to this address. After that messages are signed
// locally, so sending no longer opens the wallet at all.

async function signIn() {
  if (state.signingIn) return
  state.signingIn = true
  renderShell()

  try {
    const { address } = await callContentScript({ action: 'connectWallet' })
    if (!address) throw new Error('No wallet account available')

    const login = await callContentScript({
      action: 'signTypedData',
      typedData: loginTypedData(address),
    })
    const identity = await identityFromLoginSignature(address, login.signature)

    const typedData = bindingTypedData(address, identity.pubkey, Date.now())
    const binding = await callContentScript({ action: 'signTypedData', typedData })
    const bindingEvent = buildBindingEvent(identity, binding.signature, typedData)

    await saveIdentity(identity, bindingEvent)
    state.identity = identity
    client.setIdentity(identity)
    await client.publishBinding(bindingEvent)

    await loadNames(address)
  } catch (error) {
    console.error('Sign in failed:', error)
    alert(`Sign in failed: ${error.message}`)
  } finally {
    state.signingIn = false
    renderShell()
  }
}

async function restoreIdentity() {
  const stored = await loadIdentity()
  if (!stored) return

  state.identity = stored.identity
  client.setIdentity(stored.identity)

  // Re-announce on every start: it is one small event, and it means a relay that
  // was wiped still knows who we are before our next message lands.
  if (stored.bindingEvent) client.publishBinding(stored.bindingEvent).catch(() => {})

  const stored_ = await chrome.storage.local.get(['selectedName'])
  state.selectedName = stored_?.selectedName || ''

  loadNames(stored.identity.address).catch(() => {})
}

async function signOut() {
  await clearIdentity()
  await chrome.storage.local.remove(['selectedName'])
  callContentScript({ action: 'forgetWallet' }).catch(() => {})

  state.identity = null
  state.availableNames = []
  state.selectedName = ''
  client.setIdentity(null)
  renderShell()
}

async function loadNames(address) {
  state.availableNames = await fetchHlNames(address)
  renderShell()
}

// --- rendering ------------------------------------------------------------

function formatAddress(address) {
  if (!address) return ''
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

function replaceElementLinks(content) {
  try {
    const config = ELEMENT_LINK_CONFIG['app.hyperliquid.xyz']
    return config ? processElementLinks(content, config) : content
  } catch (error) {
    console.error('[SidePanel] Element links failed:', error)
    return content
  }
}

function relayLabel() {
  const { connected, total } = state.relays
  if (total === 0) return 'connecting...'
  return `${connected.length}/${total} relays`
}

function renderShell() {
  const root = document.getElementById('sidepanel-root')
  if (!root) return

  if (!state.uiReady) {
    root.innerHTML = `
      <div style="padding: 20px; text-align: center;">
        <h3>Waiting for Hyperliquid...</h3>
        <p>Open a market on app.hyperliquid.xyz/trade</p>
      </div>
    `
    return
  }

  const roomId = `${state.pair}_${state.market}`
  const signedIn = !!state.identity

  root.innerHTML = `
    <div class="hl-chat-widget">
      <div class="hl-chat-container visible">
        <div class="hl-chat-header">
          <div class="hl-chat-title">
            <span class="hl-chat-pair">${escapeHtml(state.pair)}</span>
            <span class="hl-chat-market">${state.market ? escapeHtml(state.market) + ' Chat' : ''}</span>
          </div>
          <div class="hl-chat-autoscroll">
            <input type="checkbox" id="autoScrollCheckbox" ${state.autoScroll ? 'checked' : ''}>
            <label for="autoScrollCheckbox">Auto-scroll</label>
          </div>
          <div class="hl-chat-controls">
            <span class="hl-relay-status" id="relayStatus" title="Relays carrying this room">${relayLabel()}</span>
            <button class="hl-sidepanel-close" id="closeSidePanel" title="Close side panel">&times;</button>
          </div>
        </div>

        <div class="hl-chat-content">
          <div class="hl-chat-messages" id="chatMessages">
            <div class="hl-loading">Loading ${escapeHtml(roomId)} chat...</div>
          </div>

          ${
            signedIn
              ? `
          <div class="hl-name-bar">
            <label class="hl-name-label">As:</label>
            <select id="hlNameSelect" class="hl-name-select-input">
              <option value="" ${state.selectedName === '' ? 'selected' : ''}>${formatAddress(state.identity.address)}</option>
              ${state.availableNames
                .map(
                  (name) =>
                    `<option value="${escapeHtml(name)}" ${name === state.selectedName ? 'selected' : ''}>${escapeHtml(name)}</option>`,
                )
                .join('')}
            </select>
            <button id="signOutButton" class="hl-sign-out-btn">Sign Out</button>
          </div>
          <div class="hl-chat-input-container">
            <input type="text" class="hl-chat-input" id="messageInput"
                   placeholder="Chat with ${escapeHtml(roomId)} traders..." maxlength="500" />
            <button class="hl-send-btn" id="sendMessage">Send</button>
          </div>
          `
              : `
          <div class="hl-chat-auth-bar" id="chatAuthBar">
            <div class="hl-auth-message">
              <span>${state.signingIn ? 'Check your wallet...' : 'Sign in with your wallet to chat'}</span>
              <button class="hl-connect-btn-small" id="signInButton" ${state.signingIn ? 'disabled' : ''}>
                ${state.signingIn ? 'Signing in...' : 'Sign In'}
              </button>
            </div>
          </div>
          `
          }
        </div>
      </div>
    </div>
  `

  attachEventListeners()
  renderMessages()
}

function renderMessages() {
  const container = document.getElementById('chatMessages')
  if (!container) return

  // client.messages is the only copy. Keeping a second one in `state` meant sign
  // out could leave the panel rendering an empty array the client never refilled.
  const messages = client.messages

  if (messages.length === 0) {
    const roomId = `${state.pair}_${state.market}`
    container.innerHTML = `<div class="hl-loading">No messages yet in ${escapeHtml(roomId)}. Be the first to chat!</div>`
    return
  }

  const myAddress = state.identity?.address

  container.innerHTML = messages
    .map((message) => {
      const isOwn = normalizeAddress(message.address) === normalizeAddress(myAddress)
      const pnl = pnlCache.get(message.address)
      // A name tag is only a claim until the chain agrees; verifyHlName resolves
      // it in the background and re-renders.
      const displayName = message.displayName || formatAddress(message.address)

      return `
        <div class="hl-message ${isOwn ? 'own' : ''}">
          <div class="hl-message-header">
            <div class="hl-message-header-left">
              <span class="hl-message-address">${escapeHtml(displayName)}</span>
            </div>
            <div class="hl-message-header-right">
              ${pnl ? `<span class="hl-pnl-badge" data-address="${escapeHtml(message.address)}" style="color: ${pnl.color};">${escapeHtml(pnl.text)}</span>` : ''}
              <span class="hl-message-time">${formatTime(message.timestamp)}</span>
            </div>
          </div>
          <div class="hl-message-content">${replaceElementLinks(escapeHtml(message.content))}</div>
        </div>
      `
    })
    .join('')

  scrollToBottom()
}

function updateChatHeader() {
  const pairElement = document.querySelector('.hl-chat-pair')
  const marketElement = document.querySelector('.hl-chat-market')
  const relayElement = document.getElementById('relayStatus')

  if (pairElement) pairElement.textContent = state.pair
  if (marketElement) marketElement.textContent = state.market ? `${state.market} Chat` : ''
  if (relayElement) relayElement.textContent = relayLabel()
}

function scrollToBottom() {
  if (!state.autoScroll) return
  const container = document.getElementById('chatMessages')
  if (container) container.scrollTop = container.scrollHeight
}

// --- events ---------------------------------------------------------------

function attachEventListeners() {
  document.getElementById('closeSidePanel')?.addEventListener('click', () => window.close())

  document.getElementById('autoScrollCheckbox')?.addEventListener('change', (event) => {
    state.autoScroll = event.target.checked
    if (state.autoScroll) scrollToBottom()
  })

  document.getElementById('signInButton')?.addEventListener('click', signIn)
  document.getElementById('signOutButton')?.addEventListener('click', signOut)
  document.getElementById('sendMessage')?.addEventListener('click', sendMessage)

  document.getElementById('messageInput')?.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') sendMessage()
  })

  document.getElementById('hlNameSelect')?.addEventListener('change', (event) => {
    state.selectedName = event.target.value
    chrome.storage.local.set({ selectedName: state.selectedName })
  })

  document.getElementById('chatMessages')?.addEventListener('click', async (event) => {
    const link = event.target.closest('a.hl-element-link')
    if (!link) return

    event.preventDefault()
    callContentScript({
      action: 'scrollToElement',
      elementSelector: link.dataset.elementSelector,
      elementId: link.dataset.elementId,
    }).catch(() => {})
  })
}

async function sendMessage() {
  const input = document.getElementById('messageInput')
  const content = input?.value?.trim()
  if (!content) return

  if (!state.identity) {
    alert('Sign in with your wallet first')
    return
  }

  input.value = ''

  try {
    const result = await client.send(content, state.selectedName)

    if (result.queued) {
      console.warn('No relay reachable; message queued and will send on reconnect')
    } else if (result.accepted.length === 0) {
      const reason = result.rejected[0]?.reason || 'every relay rejected it'
      alert(`Message not accepted: ${reason}`)
    } else if (result.underpowered) {
      console.warn('Proof of work timed out; some clients will not show this message')
    }
  } catch (error) {
    console.error('Failed to send message:', error)
    alert(`Failed to send message: ${error.message}`)
  }
}

// --- P&L ------------------------------------------------------------------

async function loadPnLForAddress(address) {
  if (!address) return

  try {
    const previous = pnlCache.get(address)
    const display = await pnlService.getPnLDisplay(address, state.pair, state.market)
    if (!display) return

    pnlCache.set(address, display)

    const badge = document.querySelector(`.hl-pnl-badge[data-address="${address}"]`)
    if (!badge) return

    if (previous && previous.raw !== display.raw) {
      badge.classList.remove('pnl-updating', 'pnl-increase', 'pnl-decrease')
      badge.classList.add('pnl-updating')

      setTimeout(() => {
        badge.textContent = display.text
        badge.style.color = display.color
        badge.classList.remove('pnl-updating')
        badge.classList.add(display.raw > previous.raw ? 'pnl-increase' : 'pnl-decrease')
        setTimeout(() => badge.classList.remove('pnl-increase', 'pnl-decrease'), 600)
      }, 500)
    } else if (!previous) {
      badge.textContent = display.text
      badge.style.color = display.color
    }
  } catch (error) {
    console.error(`Failed to load P&L for ${address}:`, error)
  }
}

async function loadAllUserPnL() {
  const addresses = [...new Set(client.messages.map((message) => message.address).filter(Boolean))]

  for (let index = 0; index < addresses.length; index++) {
    await loadPnLForAddress(addresses[index])
    // Spread the calls out; the Hyperliquid info endpoint rate limits bursts.
    if (index < addresses.length - 1) await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function startPnLPolling() {
  stopPnLPolling()
  pnlPollTimer = setInterval(() => {
    pnlService.clearCache()
    loadAllUserPnL()
  }, 120000)
}

function stopPnLPolling() {
  if (pnlPollTimer) {
    clearInterval(pnlPollTimer)
    pnlPollTimer = null
  }
}

// --- name verification ----------------------------------------------------

// Resolve claimed .hl names against on-chain ownership, then re-render. Until a
// name checks out the author shows as their address, so a stolen handle never
// renders as the real one.
async function resolveDisplayNames(messages) {
  let changed = false

  await Promise.all(
    messages.map(async (message) => {
      if (message.displayName) return
      if (!message.name) {
        message.displayName = formatAddress(message.address)
        changed = true
        return
      }

      const owned = await verifyHlName(message.address, message.name)
      message.displayName = owned ? message.name : formatAddress(message.address)
      changed = true
    }),
  )

  return changed
}

// --- startup --------------------------------------------------------------

client.onMessages(async (messages) => {
  renderMessages()

  if (await resolveDisplayNames(messages)) renderMessages()

  for (const message of messages) {
    if (!pnlCache.has(message.address)) loadPnLForAddress(message.address)
  }
})

client.onStatus((status) => {
  state.relays = status
  updateChatHeader()
})

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'roomChange' && request.pair) {
    state.pair = request.pair
    state.market = request.market || 'Perps'
    enterRoom()
  } else if (request.action === 'closeSidePanel') {
    window.close()
  }
})

async function main() {
  renderShell()
  client.start()
  await restoreIdentity()

  // The content script may not have detected the market yet; keep asking.
  const synced = await syncRoomFromPage()
  if (!synced) {
    const poll = setInterval(async () => {
      if (await syncRoomFromPage()) clearInterval(poll)
    }, 1000)
  }

  // Keep following the page if the trader switches markets with the panel open.
  setInterval(syncRoomFromPage, 5000)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main)
} else {
  main()
}
