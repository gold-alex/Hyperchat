const DEFAULT_BOOTSTRAP_PEER_MAX_ENTRIES = 16;
const PLACEHOLDER_PEER_IDS = new Set(['PEER_ID', '<peer-id>', '<PEER_ID>']);

function createBootstrapConfigError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) {
    error.details = details;
  }
  return error;
}

function isIpv4(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function isValidIpv4(host) {
  if (!isIpv4(host)) return false;
  const octets = host.split('.').map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
}

function isIpv6(host) {
  const normalized = normalizeHost(host);
  return normalized.includes(':');
}

function isLoopbackHost(host) {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1';
}

function isPrivateIpv4(host) {
  if (!isValidIpv4(host)) return false;
  const [a, b] = host.split('.').map((part) => Number(part));
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIpv6(host) {
  const normalized = normalizeHost(host).toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80:')) return true;
  return false;
}

function isSingleLabelHost(host) {
  const normalized = normalizeHost(host).toLowerCase();
  if (!normalized) return false;
  if (isValidIpv4(normalized)) return false;
  if (isIpv6(normalized)) return false;
  return !normalized.includes('.');
}

function isLocalDevelopmentHost(host) {
  const normalized = normalizeHost(host).toLowerCase();
  if (!normalized) return false;
  if (isLoopbackHost(normalized)) return true;
  if (isPrivateIpv4(normalized)) return true;
  if (isPrivateIpv6(normalized)) return true;
  if (isSingleLabelHost(normalized)) return true;
  if (normalized.endsWith('.local')) return true;
  if (normalized.endsWith('.internal')) return true;
  return false;
}

function normalizeHost(host) {
  return String(host || '').trim().replace(/^\[(.*)\]$/, '$1');
}

function hostProtocolForMultiaddr(host) {
  if (isValidIpv4(host)) return 'ip4';
  if (isIpv6(host)) return 'ip6';
  return 'dns4';
}

function normalizePeerId(peerId, contextLabel) {
  const normalized = String(peerId || '').trim();
  if (!normalized || PLACEHOLDER_PEER_IDS.has(normalized)) {
    throw createBootstrapConfigError(
      'BOOTSTRAP_PEER_ID_MISSING',
      `${contextLabel}: missing or placeholder peer ID.`,
    );
  }
  return normalized;
}

function buildWsUrl(host, port, transport) {
  const normalizedHost = normalizeHost(host);
  const hostSegment = isIpv6(normalizedHost) ? `[${normalizedHost}]` : normalizedHost;
  return `${transport}://${hostSegment}:${port}`;
}

function parseListInput(rawList, contextLabel) {
  if (Array.isArray(rawList)) {
    return rawList.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  }
  const text = String(rawList ?? '').trim();
  if (!text) return [];

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new Error('expected JSON array');
      }
      return parsed.map((entry) => String(entry ?? '').trim()).filter(Boolean);
    } catch (error) {
      throw createBootstrapConfigError(
        'BOOTSTRAP_PEERLIST_FORMAT_INVALID',
        `${contextLabel}: failed to parse JSON bootstrap peer list (${String(error.message || error)}).`,
      );
    }
  }

  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBootstrapPeerMultiaddr(entry, params) {
  const contextLabel = params.contextLabel ?? 'bootstrap peer list';
  const entryLabel = params.entryLabel ?? entry;
  const maxPort = params.maxPort ?? 65535;
  const minPort = params.minPort ?? 1;

  const match = String(entry).trim().match(
    /^\/(dns4|dns6|dnsaddr|ip4|ip6)\/([^/]+)\/tcp\/(\d{1,5})\/(ws|wss)\/p2p\/([^/]+)$/i,
  );
  if (!match) {
    throw createBootstrapConfigError(
      'BOOTSTRAP_PEER_ENTRY_INVALID',
      `${contextLabel}: invalid bootstrap peer entry "${entryLabel}". Expected multiaddr like /dns4/<host>/tcp/<port>/wss/p2p/<peerId>.`,
    );
  }

  const hostProtocol = match[1].toLowerCase();
  const host = normalizeHost(match[2]);
  const port = Number(match[3]);
  const transport = match[4].toLowerCase();
  const peerId = normalizePeerId(match[5], contextLabel);

  if (!Number.isInteger(port) || port < minPort || port > maxPort) {
    throw createBootstrapConfigError(
      'BOOTSTRAP_PEER_ENTRY_INVALID_PORT',
      `${contextLabel}: invalid port in entry "${entryLabel}". Port must be between ${minPort} and ${maxPort}.`,
    );
  }

  if (transport === 'ws' && !isLocalDevelopmentHost(host)) {
    throw createBootstrapConfigError(
      'BOOTSTRAP_PEER_INSECURE_TRANSPORT',
      `${contextLabel}: insecure websocket transport is not allowed for non-local host "${host}" in entry "${entryLabel}". Use wss or local-only endpoints.`,
    );
  }

  const normalized = `/${hostProtocol}/${host}/tcp/${port}/${transport}/p2p/${peerId}`;
  const wsUrl = buildWsUrl(host, port, transport);

  return {
    multiaddr: normalized,
    host,
    hostProtocol,
    port,
    transport,
    peerId,
    wsUrl,
    isLocalHost: isLocalDevelopmentHost(host),
  };
}

function dedupePeers(peers) {
  const seen = new Set();
  const output = [];
  for (const peer of peers) {
    const key = peer.multiaddr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(peer);
  }
  return output;
}

function parseBootstrapPeerList(rawList, options = {}) {
  const contextLabel = options.contextLabel ?? 'bootstrap peer list';
  const maxEntries = options.maxEntries ?? DEFAULT_BOOTSTRAP_PEER_MAX_ENTRIES;
  const parsedEntries = parseListInput(rawList, contextLabel);
  const hadRawInput =
    (typeof rawList === 'string' && rawList.trim().length > 0)
    || (Array.isArray(rawList) && rawList.length > 0);

  if (hadRawInput && parsedEntries.length === 0) {
    throw createBootstrapConfigError(
      'BOOTSTRAP_PEERLIST_EMPTY',
      `${contextLabel}: configured bootstrap peer list is empty after parsing.`,
    );
  }

  if (parsedEntries.length > maxEntries) {
    throw createBootstrapConfigError(
      'BOOTSTRAP_PEERLIST_TOO_LARGE',
      `${contextLabel}: configured ${parsedEntries.length} entries, max supported is ${maxEntries}.`,
    );
  }

  const peers = [];
  const errors = [];
  parsedEntries.forEach((entry, index) => {
    const entryLabel = `[${index + 1}] ${entry}`;
    try {
      peers.push(parseBootstrapPeerMultiaddr(entry, { ...options, contextLabel, entryLabel }));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });

  if (errors.length > 0) {
    throw createBootstrapConfigError(
      'BOOTSTRAP_PEERLIST_INVALID',
      `${contextLabel}: one or more entries are invalid.\n- ${errors.join('\n- ')}`,
      { errors },
    );
  }

  return dedupePeers(peers);
}

function normalizeEndpointHost(endpoint) {
  const value = String(endpoint ?? '').trim();
  if (!value) return { host: '', scheme: '' };
  try {
    const parsed = new URL(value);
    return {
      host: normalizeHost(parsed.hostname),
      scheme: parsed.protocol.replace(':', '').toLowerCase(),
    };
  } catch {
    return {
      host: normalizeHost(value),
      scheme: '',
    };
  }
}

function buildLegacyBootstrapPeerFromHost(options = {}) {
  const contextLabel = options.contextLabel ?? 'legacy bootstrap peer';
  const endpoint = normalizeEndpointHost(options.host);
  const host = endpoint.host;
  const peerId = normalizePeerId(options.peerId, contextLabel);
  const port = Number(options.port);

  if (!host) {
    throw createBootstrapConfigError(
      'BOOTSTRAP_LEGACY_HOST_MISSING',
      `${contextLabel}: missing legacy host. Set bootstrap peer list or provide legacy host/port/peer ID.`,
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createBootstrapConfigError(
      'BOOTSTRAP_LEGACY_PORT_INVALID',
      `${contextLabel}: invalid legacy port "${String(options.port)}".`,
    );
  }

  const schemeHint = String(options.schemeHint || endpoint.scheme || '').trim().toLowerCase();
  let transport = schemeHint === 'wss' ? 'wss' : schemeHint === 'ws' ? 'ws' : '';
  if (!transport) {
    transport = isLocalDevelopmentHost(host) ? 'ws' : 'wss';
  }

  const hostProtocol = hostProtocolForMultiaddr(host);
  const multiaddr = `/${hostProtocol}/${host}/tcp/${port}/${transport}/p2p/${peerId}`;
  return parseBootstrapPeerMultiaddr(multiaddr, { ...options, contextLabel });
}

function buildLegacyBootstrapPeerFromWsUrl(options = {}) {
  const contextLabel = options.contextLabel ?? 'legacy bootstrap peer';
  const wsUrl = String(options.wsUrl || '').trim();
  if (!wsUrl) {
    throw createBootstrapConfigError(
      'BOOTSTRAP_LEGACY_WS_URL_MISSING',
      `${contextLabel}: missing legacy websocket URL.`,
    );
  }
  let parsed;
  try {
    parsed = new URL(wsUrl);
  } catch {
    throw createBootstrapConfigError(
      'BOOTSTRAP_LEGACY_WS_URL_INVALID',
      `${contextLabel}: invalid websocket URL "${wsUrl}".`,
    );
  }
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'ws' && scheme !== 'wss') {
    throw createBootstrapConfigError(
      'BOOTSTRAP_LEGACY_WS_URL_INVALID_SCHEME',
      `${contextLabel}: websocket URL must use ws or wss, got "${scheme}".`,
    );
  }
  const port = Number(parsed.port || (scheme === 'wss' ? 443 : 80));
  return buildLegacyBootstrapPeerFromHost({
    contextLabel,
    host: parsed.hostname,
    port,
    peerId: options.peerId,
    schemeHint: scheme,
  });
}

export {
  DEFAULT_BOOTSTRAP_PEER_MAX_ENTRIES,
  buildLegacyBootstrapPeerFromHost,
  buildLegacyBootstrapPeerFromWsUrl,
  createBootstrapConfigError,
  isLocalDevelopmentHost,
  parseBootstrapPeerList,
};
