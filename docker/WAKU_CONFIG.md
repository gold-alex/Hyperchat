# Waku Configuration Guide

## Environment Variables

The Waku integration uses the following environment variables for configuration:

```
# Waku configuration
WAKU_NODE_URI=testnet.example.io    # URI / IP of your nwaku node
WAKU_NODE_PORT=443          # Port of your nwaku node (default: 60000)
WAKU_NODE_PEER_ID=16Uiu2HAm...# Peer ID of your nwaku node (from startup logs)
```

## How to Configure

1. Create a `.env` file in the project root with the above variables
2. Replace the values with your actual nwaku node configuration
3. Run `pnpm build` to build the extension with your configuration

## Finding Your Node's Peer ID

When you start your nwaku node, it will output its peer ID in the startup logs. Look for a line like:

```
INF 2023-08-23 12:34:56.789+00:00 Node started  topics="waku node" peerId=16Uiu2HAm...
```

The string after `peerId=` is your node's peer ID.

## Running a Local Nwaku Node

If you're running a local nwaku node, you can find more information about configuration and setup in the [nwaku documentation](https://docs.waku.org/guides/nwaku/run-nwaku/).
