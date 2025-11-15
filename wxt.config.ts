import { defineConfig } from 'wxt';
import path from 'node:path';

export default defineConfig({
  manifest: async () => ({
    manifest_version: 3,
    name: 'Hyperliquid Chat',
    version: '1.0.0',
    description: 'Chat with traders on Hyperliquid',
    permissions: ['activeTab', 'tabs', 'storage', 'scripting', 'sidePanel', 'contextMenus'],
    host_permissions: [
	  'https://app.hyperliquid.xyz/*',
	  'ws://10.0.0.58:8000/'
    ],
    action: {
      default_title: 'Open Hyperliquid Chat',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    // Keep these resources accessible to content/page contexts
    web_accessible_resources: [
      {
        resources: [
          'chat-widget.html',
          'chat-widget.js',
          'wallet-bridge.js',
          'lib/waku-chat-client.js',
          'lib/js-waku.min.js',
          'lib/protobufjs/minimal.js',
          'lib/protobuf-wrapper.js',
          'lib/chat-message.js',
          'lib/chat-message.proto',
          // Provide a stable stylesheet for extension pages
          'content.css'
        ],
        matches: ['https://app.hyperliquid.xyz/*']
      }
    ],
  }),

  outDir: "dist",

  // Ensure Vite exposes VITE_ env vars to our code
  vite: () => ({
    define: {
      __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
  }),

  // Copy required static assets (lib/, wallet-bridge.js, content.css) into the build output
  hooks: {
    'build:publicAssets': (wxt, files) => {
      const root = wxt.config.root;
      const add = (absoluteSrc: string, relativeDest: string) => {
        files.push({ absoluteSrc, relativeDest });
      };

      // Copy wallet bridge used by content script injected into page context
      add(path.resolve(root, 'wallet-bridge.js'), 'wallet-bridge.js');

      // Copy chat widget launcher (page) assets so background can open it
      // Note: entrypoints/chat-widget/index.html builds to chat-widget.html; this
      // entry ensures legacy references still resolve in pages
      // (The script is re-bundled, this is just for safety if referenced elsewhere)
      // add(path.resolve(root, 'chat-widget.js'), 'chat-widget.js'); // not needed when bundled

      // Copy lib/ prebundled Waku/protobuf artifacts verbatim
      const libFiles = [
        'lib/waku-chat-client.js',
        'lib/js-waku.min.js',
        'lib/protobufjs/minimal.js',
        'lib/protobuf-wrapper.js',
        'lib/chat-message.js',
        'lib/chat-message.proto',
      ];
      for (const rel of libFiles) {
        add(path.resolve(root, rel), rel);
      }

      // Copy a stable CSS file for sidepanel/chat-widget pages
      add(path.resolve(root, 'content.css'), 'content.css');
    },
  },
});

