// Shared test setup.
//
// Note there is no global Date.now mock any more. The old one pinned the clock to
// 2021, which silently breaks anything that reasons about event timestamps or
// history windows. Tests that need a fixed clock should fake it themselves.

global.TextEncoder = require('util').TextEncoder
global.TextDecoder = require('util').TextDecoder

// A chrome.storage.local that actually stores things, and returns promises the way
// MV3 does, so code under test can await it.
function createStorageArea() {
  const data = new Map()

  return {
    get: jest.fn((keys, callback) => {
      const requested = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {})
      const result = {}
      for (const key of requested) {
        if (data.has(key)) result[key] = data.get(key)
      }
      if (callback) {
        callback(result)
        return undefined
      }
      return Promise.resolve(result)
    }),

    set: jest.fn((items, callback) => {
      for (const [key, value] of Object.entries(items)) data.set(key, value)
      if (callback) {
        callback()
        return undefined
      }
      return Promise.resolve()
    }),

    remove: jest.fn((keys, callback) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key)
      if (callback) {
        callback()
        return undefined
      }
      return Promise.resolve()
    }),

    clear: jest.fn(() => {
      data.clear()
      return Promise.resolve()
    }),

    _data: data,
  }
}

global.chrome = {
  runtime: {
    getURL: jest.fn((path) => `chrome-extension://test/${path}`),
    onMessage: { addListener: jest.fn() },
    sendMessage: jest.fn(() => Promise.resolve()),
    lastError: null,
  },
  storage: { local: createStorageArea() },
  tabs: {
    query: jest.fn(() => Promise.resolve([])),
    create: jest.fn(),
    update: jest.fn(),
    sendMessage: jest.fn(() => Promise.resolve()),
    onUpdated: { addListener: jest.fn(), removeListener: jest.fn() },
  },
  scripting: { executeScript: jest.fn() },
  sidePanel: { setOptions: jest.fn(() => Promise.resolve()), setPanelBehavior: jest.fn(() => Promise.resolve()) },
  windows: { WINDOW_ID_CURRENT: -2 },
}

global.fetch = jest.fn()

global.setupTestDOM = () => {
  document.body.innerHTML = ''
  const container = document.createElement('div')
  document.body.appendChild(container)
  return container
}
