#!/usr/bin/env node

// Builds the unpacked extension into dist/.
//
// The old build was a file copier, which worked only because everything shipped
// as a pre-bundled blob. The nostr client has real dependencies, so entry points
// now go through esbuild. Scripts that get injected into the Hyperliquid page
// itself are still copied verbatim - they must stay standalone.

const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

require('dotenv').config()

const watch = process.argv.includes('--watch')

// Bundled: these import from lib/.
const ENTRY_POINTS = ['content.js', 'sidepanel.js', 'background.js', 'popup.js', 'chat-widget.js']

// Copied as-is: injected into the page context, or loaded by the browser directly.
const COPY_FILES = [
  'manifest.json',
  'popup.html',
  'chat-widget.html',
  'sidepanel.html',
  'content.css',
  'wallet-bridge.js',
  'links-config-global.js',
  'icon-16.png',
  'icon-32.png',
  'icon-48.png',
  'icon-128.png',
]

const relays = (process.env.HYPERCHAT_RELAYS || '').trim()
// api.hlnames.xyz answers 401 without a key, so without a default the .hl name
// dropdown silently empties. This key already shipped inside the extension and is
// in git history - it is public by construction, since any user can read it out of
// the bundle. Override it with HLNAMES_API_KEY if you want your own quota.
const hlNamesKey = (process.env.HLNAMES_API_KEY || 'CPEPKMI-HUSUX6I-SE2DHEA-YYWFG5Y').trim()

const buildOptions = {
  entryPoints: ENTRY_POINTS,
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  platform: 'browser',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  define: {
    __HYPERCHAT_RELAYS__: JSON.stringify(relays),
    __HLNAMES_API_KEY__: JSON.stringify(hlNamesKey),
    // viem and nostr-tools both probe for a node environment.
    'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
    global: 'globalThis',
  },
}

function copyStaticFiles() {
  for (const file of COPY_FILES) {
    if (!fs.existsSync(file)) {
      if (!file.startsWith('icon-')) console.warn(`  ! ${file} not found, skipping`)
      continue
    }
    fs.copyFileSync(file, path.join('dist', file))
  }
}

async function main() {
  fs.rmSync('dist', { recursive: true, force: true })
  fs.mkdirSync('dist')

  if (watch) {
    const context = await esbuild.context(buildOptions)
    await context.watch()
    copyStaticFiles()
    console.log('\nWatching for changes. Reload the extension in chrome://extensions to pick them up.')
    return
  }

  await esbuild.build(buildOptions)
  copyStaticFiles()

  console.log('\nBuild complete.')
  console.log(`  relays: ${relays || '(defaults from lib/nostr/config.js)'}`)
  console.log(`  hlnames key: ${process.env.HLNAMES_API_KEY ? 'from env' : 'built-in default'}`)
  console.log('  load dist/ via chrome://extensions with Developer mode on')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
