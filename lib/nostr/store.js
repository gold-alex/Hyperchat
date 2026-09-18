// The local copy of every room the user has been in.
//
// This is what makes a browser useful to the network despite never being
// reachable: the panel holds the conversation, notices when a relay is missing
// part of it, and puts it back. It is also why reopening a room paints instantly
// instead of waiting on a round trip.
//
// Built as a factory rather than a module singleton so two clients can be run
// side by side with genuinely separate storage - otherwise a test proving that a
// message crossed the network would really just be reading it back out of shared
// memory.

import { SYNC } from './config.js'

const DB_NAME = 'hyperchat'
const DB_VERSION = 1
const EVENTS = 'events'
const BINDINGS = 'bindings'

function hasIndexedDb() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Private windows, blocked site data, and node all land here. Chat still works, it
// just stops contributing history once the tab closes.
function createMemoryBackend() {
  const events = new Map()
  const bindings = new Map()

  return {
    async putEvents(room, incoming) {
      let added = 0
      for (const event of incoming) {
        if (!events.has(event.id)) {
          events.set(event.id, { ...event, room })
          added++
        }
      }
      return added
    },

    async getEvents(room, { limit, since }) {
      return [...events.values()]
        .filter((event) => event.room === room && event.created_at >= since)
        .sort((a, b) => a.created_at - b.created_at)
        .slice(-limit)
    },

    async putBinding(record) {
      bindings.set(record.pubkey, record)
    },

    async getBinding(pubkey) {
      return bindings.get(pubkey) || null
    },

    async clearAll() {
      events.clear()
      bindings.clear()
    },
  }
}

function createIndexedDbBackend() {
  let dbPromise = null

  function openDb() {
    if (dbPromise) return dbPromise

    dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION)

      open.onupgradeneeded = () => {
        const db = open.result
        if (!db.objectStoreNames.contains(EVENTS)) {
          const store = db.createObjectStore(EVENTS, { keyPath: 'id' })
          store.createIndex('room', 'room', { unique: false })
          store.createIndex('room_created', ['room', 'created_at'], { unique: false })
        }
        if (!db.objectStoreNames.contains(BINDINGS)) {
          db.createObjectStore(BINDINGS, { keyPath: 'pubkey' })
        }
      }

      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })

    return dbPromise
  }

  function transaction(storeName, mode, work) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, mode)
          let result
          try {
            result = work(tx.objectStore(storeName))
          } catch (error) {
            reject(error)
            return
          }
          tx.oncomplete = () => resolve(result)
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        }),
    )
  }

  async function prune(room) {
    const rows = await transaction(EVENTS, 'readonly', (store) =>
      request(store.index('room').getAll(IDBKeyRange.only(room))),
    )
    if (!rows || rows.length <= SYNC.localCapPerRoom) return

    const doomed = rows
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, rows.length - SYNC.localCapPerRoom)

    await transaction(EVENTS, 'readwrite', (store) => {
      for (const row of doomed) store.delete(row.id)
    })
  }

  return {
    async putEvents(room, incoming) {
      await transaction(EVENTS, 'readwrite', (store) => {
        for (const event of incoming) store.put({ ...event, room })
      })
      await prune(room).catch(() => {
        // The cap is a courtesy, not a guarantee.
      })
      return incoming.length
    },

    async getEvents(room, { limit, since }) {
      const range = IDBKeyRange.bound([room, since], [room, Number.MAX_SAFE_INTEGER])
      const rows = await transaction(EVENTS, 'readonly', (store) =>
        request(store.index('room_created').getAll(range)),
      )
      return (rows || []).sort((a, b) => a.created_at - b.created_at).slice(-limit)
    },

    async putBinding(record) {
      await transaction(BINDINGS, 'readwrite', (store) => store.put(record))
    },

    async getBinding(pubkey) {
      return (await transaction(BINDINGS, 'readonly', (store) => request(store.get(pubkey)))) || null
    },

    async clearAll() {
      await transaction(EVENTS, 'readwrite', (store) => store.clear())
      await transaction(BINDINGS, 'readwrite', (store) => store.clear())
    },
  }
}

export function createStore({ forceMemory = false } = {}) {
  const primary = !forceMemory && hasIndexedDb() ? createIndexedDbBackend() : createMemoryBackend()
  // If IndexedDB throws mid-session - quota, private mode, a locked profile - fall
  // through to memory rather than losing the room.
  const fallback = createMemoryBackend()

  async function attempt(operation) {
    try {
      return await operation(primary)
    } catch {
      return operation(fallback)
    }
  }

  return {
    putEvents(room, events) {
      if (!events || events.length === 0) return Promise.resolve(0)
      return attempt((backend) => backend.putEvents(room, events))
    },

    getEvents(room, { limit = SYNC.historyLimit, since = 0 } = {}) {
      return attempt((backend) => backend.getEvents(room, { limit, since }))
    },

    async getEventIds(room) {
      const events = await this.getEvents(room, { limit: SYNC.localCapPerRoom })
      return new Set(events.map((event) => event.id))
    },

    // A null address means "checked, and this one does not hold up" - cached so an
    // unbound key does not cost a round trip on every paint.
    putBinding(pubkey, address, checkedAt = Date.now()) {
      return attempt((backend) => backend.putBinding({ pubkey, address, checkedAt }))
    },

    getBinding(pubkey) {
      return attempt((backend) => backend.getBinding(pubkey))
    },

    clearAll() {
      return attempt((backend) => backend.clearAll())
    },
  }
}

// The one the extension uses. Tests build their own.
export const defaultStore = createStore()
