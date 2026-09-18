// .hl name lookup and verification.
//
// The name on a message is only a claim - it rides in a tag that its author wrote
// themselves. The old backend checked ownership before letting a message into the
// database; with no backend, every client checks for itself before rendering the
// name. An unverified claim falls back to the address, so a borrowed handle never
// shows up as the real one.

const HLNAMES_API = 'https://api.hlnames.xyz'

// Substituted at build time. This has to ship inside the extension to be usable
// from the client at all, so treat it as public and rate-limited, not secret.
const API_KEY = typeof __HLNAMES_API_KEY__ === 'string' ? __HLNAMES_API_KEY__ : ''

const ownershipCache = new Map()
const CACHE_TTL_MS = 10 * 60 * 1000

async function namesOwnedBy(address) {
  const key = String(address || '').toLowerCase()
  if (!key) return []

  const cached = ownershipCache.get(key)
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached.names

  try {
    const response = await fetch(`${HLNAMES_API}/utils/names_owner/${key}`, {
      headers: API_KEY ? { 'X-API-Key': API_KEY } : {},
    })
    if (!response.ok) throw new Error(`hlnames ${response.status}`)

    const payload = await response.json()
    const names = Array.isArray(payload) ? payload.map((entry) => entry.name).filter(Boolean) : []

    ownershipCache.set(key, { checkedAt: Date.now(), names })
    return names
  } catch {
    // Cache the failure briefly so an outage does not mean one request per paint.
    ownershipCache.set(key, { checkedAt: Date.now(), names: [] })
    return []
  }
}

export async function fetchHlNames(address) {
  return namesOwnedBy(address)
}

export async function verifyHlName(address, name) {
  if (!name) return false
  const names = await namesOwnedBy(address)
  return names.some((owned) => owned.toLowerCase() === String(name).toLowerCase())
}

export function clearNameCache() {
  ownershipCache.clear()
}
