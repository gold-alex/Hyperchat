# Hyperliquid Chat (WXT)

This repo contains a Chrome/Chromium extension built with WXT. It injects a floating chat UI on Hyperliquid and offers a side panel (and optionally, a toolbar popup) to control the experience. Real‑time messaging is powered by a local Waku client bundled inside the extension (no remote code).

## Quick Start

- Install deps (pnpm 10+ recommended)
- Copy `.env.example` to `.env` and set Waku values as needed

```
pnpm install
pnpm dev:ext           # WXT dev server (load the dev extension in your browser)
```

## Build & Package

```
pnpm build             # Protobuf compile + wxt build → .output/chrome-mv3
pnpm preview           # Build only (then load unpacked from .output/chrome-mv3)
pnpm zip               # Build + zip artifacts
pnpm clean             # Remove .output, coverage, dist
```

## Tests (Vitest)

This project uses Vitest with a simulated browser environment.

- Runner: `vitest`
- DOM: `happy-dom` (quieter, faster for this project than jsdom)
- Extension APIs: `fakeBrowser` from `wxt/testing`, injected as global `chrome` and `browser` in `vitest.setup.ts`

Common commands:

```
pnpm test              # Run once
pnpm test:watch        # Watch mode
pnpm test:coverage     # Coverage report
```

Notes:
- We provide a Jest‑compat shim in `vitest.setup.ts` (`global.jest = vi`) so legacy tests can pass while we convert them.
- Wallet bridge injection is disabled during tests via `global.DISABLE_WALLET_BRIDGE` to avoid loading scripts into the synthetic DOM.

## Lint & Typecheck

```
pnpm lint              # ESLint (flat config)
pnpm lint:fix          # ESLint --fix
pnpm typecheck         # TypeScript noEmit
```

## Environment Variables

These are read by Vite (WXT) at build time. See `.env.example`.

- `VITE_WAKU_NODE_URI` (string, e.g. `localhost`)
- `VITE_WAKU_NODE_PORT` (number, e.g. `443`)
- `VITE_WAKU_NODE_PEER_ID` (string peer ID)

## Remote Code Policy (WXT compliant)

- All Waku/protobuf modules are local under `lib/` and included in the extension bundle. They are loaded using `chrome.runtime.getURL(...)`.
- No remote ESM/CDN imports or `eval` are used anywhere in the extension.
- External HTTP(S) calls (e.g., Waku peers, HL name lookup) fetch data, not code.

## Waku Testing (outside the extension)

See `test-waku-direct.html` and `test-waku-node.js` for manual, out‑of‑band testing against your Waku peers.

## Project Layout

- `entrypoints/` — WXT entrypoints (background, content, sidepanel, etc.)
- `src/` — shared modules (e.g., `hyperliquid-chat.js`, `messages.ts`)
- `lib/` — local Waku + protobuf artifacts (bundled as static assets)
- `.output/chrome-mv3/` — build output

## Troubleshooting

- “Remote code” warnings: ensure no http(s) imports or dynamic script injections outside `chrome.runtime.getURL(...)`.
- Tests complaining about `chrome.*` APIs: make sure `vitest.setup.ts` is loaded (it injects `fakeBrowser`).
- Content tests failing on wallet bridge loading: that injection is disabled in tests via `DISABLE_WALLET_BRIDGE`.
