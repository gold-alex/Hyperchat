# HyperChat

A drop-in, decentralised chat feed for Hyperliquid markets, in the spirit of OG BitMEX.

Every market page gets its own room. Traders sign in with the wallet they already
trade with, chat under a `.hl` name they own, and carry PnL flair from their real
trading history. No account, no server, no signup.

## How it works

The whole product is the Chrome extension. There is nothing else to install and
nothing to run.

Messages travel over [nostr](https://github.com/nostr-protocol/nips), which is a
network of dumb mailboxes ("relays") that hold signed messages and hand them out
when asked. Hundreds already run publicly; HyperChat talks to five of them at once
and ignores everything on them that isn't HyperChat traffic.

Public relays are individually unreliable, so the panel routinely shows 4/5 rather
than 5/5. That is the design absorbing a flaky relay, not a fault.

Three things follow from that:

**No single point of failure.** Relays are used simultaneously, not as a failover
chain. Any one of them can go down, or be wiped, and the room keeps working.

**Every user carries the room.** The extension keeps the rooms you've visited in
local storage, and when it notices a relay is missing part of a room, it quietly
puts it back. A pruned room heals from whoever walks in next. There's no setting
for this and it costs the user nothing.

**Nothing can forge a message.** Every message is signed, and every client
independently re-checks every message it renders. A hostile relay can withhold
messages but cannot alter one — and withholding is what connecting to five relays
defeats.

### Identity

Nostr signs with its own keypair, not your Ethereum key, so sign-in bridges the two:

1. One EIP-712 signature is hashed into your chat key. It never leaves your machine.
   The same wallet reproduces the same identity on any device.
2. A second EIP-712 signature is published, proving that chat key belongs to your
   address.

Both happen once, at sign-in. After that the wallet is never opened again — messages
are signed locally, so sending is instant instead of a wallet popup per message.

Because the binding is public and verifiable, every client can independently confirm
which address is behind a message, and from there show the right `.hl` name and PnL.

### Keeping spam out

Ethereum addresses are free, so "has a wallet" gates nothing. The real gate is that
**an author must have actually traded on Hyperliquid.** Keypairs cost nothing;
funded, traded HL accounts cost real money, one deposit at a time.

Four checks run in every client, at render time, cheapest first:

| Check | Cost to a spammer |
|---|---|
| Proof of work on every message | ~0.15s per message, ~25 min of CPU per 10k flood |
| Signature and block list | — |
| Wallet binding | Needs a real signature |
| Has traded on Hyperliquid | A funded account per identity |
| Rate limit (10/min per author) | Applied when drawing, not when sending |

Because these run at render time, someone who reverse-engineers the message format
can publish whatever they like to a public relay and it will reach nobody. Their
messages sit on a stranger's disk, unrendered. There is no central gatekeeper to
compromise, because every client is its own gatekeeper.

All of it is tunable in one place: `SPAM_POLICY` in `lib/nostr/config.js`.

## Install

```sh
pnpm install
pnpm build
```

Then in Chrome or Brave:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select the `dist/` folder

Open a market on `app.hyperliquid.xyz/trade`, then click the extension icon to open
the side panel.

`pnpm watch` rebuilds on change; reload the extension to pick changes up.

### Configuration

Both are optional — copy `.env-example` to `.env` to set them.

- `HYPERCHAT_RELAYS` — comma-separated relay list. Put your own relay first. Unset
  uses the public defaults in `lib/nostr/config.js`.
- `HLNAMES_API_KEY` — key for `api.hlnames.xyz`, used to verify a trader really owns
  the `.hl` name on their messages. The API returns 401 without one, so a working
  default is built in; set this to use your own quota. Either way the key ships
  inside the extension, so treat it as public and rate-limited.

## Running your own relay

Entirely optional — the extension works without it. What it buys you is an anchor
that never prunes and only accepts HyperChat traffic, so a room can always be
recovered even if every public relay drops it.

```sh
cd relay
docker compose up -d --build
```

This builds [strfry](https://github.com/hoytech/strfry) from source and runs it
behind the write policy in `relay/write-policy.js`, which enforces the same rules
the clients do: HyperChat event kinds only, proof of work, message length, and a
per-author rate limit.

It binds to `127.0.0.1:7777`. Put a TLS proxy in front of it — a browser on an
`https://` page cannot open a plaintext `ws://` socket, so it has to be reachable
over `wss://` before the extension can use it. Then add it to `HYPERCHAT_RELAYS`
and rebuild.

Keep the limits in `relay/docker-compose.yml` in step with `SPAM_POLICY`. If the
relay demands more work than the extension does, your own users get rejected.

## Layout

```
content.js            market detection, wallet bridge, element scrolling
sidepanel.js          the chat client: UI, sign-in, rooms, PnL
background.js         service worker; routes room changes
lib/nostr/
  config.js           relays, event kinds, spam policy - the tuning knobs
  identity.js         wallet-bound chat keys, binding proofs
  event.js            message events, proof of work
  pool.js             multi-relay connections, reconnect, publish
  store.js            local room history (IndexedDB)
  moderation.js       the render gate
  client.js           ties it together, including the repair pass
  names.js            .hl name lookup and verification
relay/                optional anchor relay
```

Sockets live in the side panel, not the service worker: MV3 workers idle out and
would drop the connections.

## Tests

```sh
pnpm test
```

The network tests run real clients over real WebSockets against in-process relays
(`__tests__/helpers/mock-relay.js`) — nothing is published to public relays. They
cover a message reaching a stranger, writes landing on every relay, a room
surviving a relay dropping out, a wiped relay being healed by a client that still
holds the history, and an unbound author being rendered by nobody.
