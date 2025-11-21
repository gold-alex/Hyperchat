#!/bin/bash
# Start nwaku node in test mode
# Usage: ./docker/start-test-node.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$SCRIPT_DIR"

echo "Starting dual-nwaku test stack via docker-compose..."
echo ""

PRIMARY_RUNNING=false
RELAY_RUNNING=false

if docker ps --format '{{.Names}}' | grep -q "^nwaku-node$"; then
    PRIMARY_RUNNING=true
fi
if docker ps --format '{{.Names}}' | grep -q "^nwaku-relay$"; then
    RELAY_RUNNING=true
fi

if $PRIMARY_RUNNING || $RELAY_RUNNING; then
    echo "! Existing containers detected:"
    $PRIMARY_RUNNING && echo "   - nwaku-node"
    $RELAY_RUNNING && echo "   - nwaku-relay"
    read -p "   Restart both? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        docker-compose stop nwaku-relay nwaku || true
        docker-compose rm -f nwaku-relay nwaku || true
    else
        echo "! Leaving containers untouched."
        exit 0
    fi
fi

# Ensure we're using test configuration
export WAKU_WS_PORT=8000
export WAKU_REST_PORT=8645
export WAKU_DB_PATH=./nwaku_test_db
export WAKU_RELAY_WS_PORT=8100
export WAKU_RELAY_REST_PORT=8745
export WAKU_RELAY_DB_PATH=./nwaku_relay_test_db
# Force deterministic intra-docker IPs so secondary peers can dial the primary
export NWAKU_IP=${NWAKU_IP:-172.28.0.10}
export NWAKU_RELAY_IP=${NWAKU_RELAY_IP:-172.28.0.11}
export PUBLIC_IP=$NWAKU_IP
# For test runs, advertise localhost to avoid Docker/NAT DNS names
export WAKU_WSS_DOMAIN=localhost

# Compute host DB path for convenience (works regardless of cwd)
# Start the primary LightPush/Filter/Store node
docker-compose up -d nwaku

echo "Waiting for node to start..."
sleep 5

# Get node info
echo ""
echo "Node Information:"
echo "   Container:  nwaku-node"
echo "   WebSocket:  ws://localhost:8000"
echo "   REST API:   http://localhost:8645"

# Extract peer ID from REST API
echo "   Extracting Peer ID from REST API..."
sleep 5
PEER_ID=$(curl -s http://localhost:8645/debug/v1/info 2>/dev/null | grep -oP '"listenAddresses":\["[^"]*/p2p/\K[^"]+' | head -1)

if [ -z "$PEER_ID" ]; then
    echo "   Peer ID not available yet, waiting..."
    sleep 10
    PEER_ID=$(curl -s http://localhost:8645/debug/v1/info 2>/dev/null | grep -oP '"listenAddresses":\["[^"]*/p2p/\K[^"]+' | head -1)
fi

if [ -n "$PEER_ID" ]; then
    export PRIMARY_WAKU_PEER_ID="$PEER_ID"
fi

# Start the upstream relay peer
echo ""
echo "Starting helper relay peer (nwaku-relay)..."
docker-compose up -d nwaku-relay
echo "Waiting for relay to start..."
sleep 5
RELAY_PEER_ID=$(curl -s http://localhost:${WAKU_RELAY_REST_PORT}/debug/v1/info 2>/dev/null | grep -oP '"listenAddresses":\["[^"]*/p2p/\K[^"]+' | head -1)
if [ -z "$RELAY_PEER_ID" ]; then
    sleep 5
    RELAY_PEER_ID=$(curl -s http://localhost:${WAKU_RELAY_REST_PORT}/debug/v1/info 2>/dev/null | grep -oP '"listenAddresses":\["[^"]*/p2p/\K[^"]+' | head -1)
fi
if [ -n "$RELAY_PEER_ID" ]; then
    echo "   Relay Peer ID: ${RELAY_PEER_ID}"
else
    echo "   (Relay Peer ID unavailable yet; check docker logs nwaku-relay)"
fi

if [ -n "$PEER_ID" ]; then
    echo "   Peer ID:    ${PEER_ID}"
    echo ""
    echo "Dual-node Waku stack is running!"
    echo ""
    echo "Add these values to ${PROJECT_ROOT}/.env:"
    echo ""
    echo "VITE_WAKU_NODE_URI=localhost"
    echo "VITE_WAKU_NODE_PORT=8000"
    echo "VITE_WAKU_NODE_PEER_ID=${PEER_ID}"
    echo "PRIMARY_WAKU_PEER_ID=${PEER_ID}"
    if [ -n "$RELAY_PEER_ID" ]; then
        echo "WAKU_RELAY_PEER_ID=${RELAY_PEER_ID}"
    fi
    echo ""
    echo "Useful commands:"
    echo "   View primary logs:  docker logs -f nwaku-node"
    echo "   View relay logs:    docker logs -f nwaku-relay"
    echo "   Stop stack:         docker-compose stop"
    echo "   Remove stack:       docker-compose down"
    echo "   Restart primary:    docker-compose restart nwaku"
    echo "   Restart relay:      docker-compose restart nwaku-relay"
    echo "   Check DB (sqlite sidecar):"
    echo "                  docker-compose run --rm sqlite /db/waku_messages.db 'SELECT COUNT(*) FROM messages;'"
    echo "   Alt: host sqlite3:"
    echo "                  sqlite3 '$SCRIPT_DIR/${WAKU_DB_PATH#./}/waku_messages.db' 'SELECT COUNT(*) FROM messages;'"
    echo "   REST info:     curl http://localhost:8645/debug/v1/info | jq"
    echo "   Relay REST:    curl http://localhost:${WAKU_RELAY_REST_PORT}/debug/v1/info | jq"
    echo "   Store query:   curl 'http://localhost:8645/store/v3/messages?contentTopics=/hl-chat/1/BTC-USD_Perps/proto' | jq"
else
    echo "Warning: Could not extract Peer ID"
    echo "   The node may still be starting up."
    echo "   Check logs manually: docker logs nwaku-node"
    echo "   Or try REST API: curl http://localhost:8645/debug/v1/info | jq"
fi
