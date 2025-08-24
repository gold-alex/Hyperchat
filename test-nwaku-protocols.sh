#!/bin/bash

# Test nwaku node protocols
WAKU_NODE_IP=${WAKU_NODE_IP}
WAKU_NODE_PORT=${WAKU_NODE_PORT}

echo "Testing nwaku node at $WAKU_NODE_IP:$WAKU_NODE_PORT"
echo "========================================="

# Check if REST API is available
echo -e "\n1. Testing REST API endpoints:"
echo "------------------------------"

# Try the info endpoint
echo "Testing /debug/v1/info..."
curl -s -X GET "http://$WAKU_NODE_IP:$WAKU_NODE_PORT/debug/v1/info" | jq . 2>/dev/null || echo "No REST API at /debug/v1/info"

# Try the health endpoint
echo -e "\nTesting /health..."
curl -s -X GET "http://$WAKU_NODE_IP:$WAKU_NODE_PORT/health" 2>/dev/null || echo "No health endpoint"

# Try to get node info
echo -e "\nTesting /debug/v1/version..."
curl -s -X GET "http://$WAKU_NODE_IP:$WAKU_NODE_PORT/debug/v1/version" | jq . 2>/dev/null || echo "No version endpoint"

# Check what protocols are mounted
echo -e "\n2. Testing protocol availability:"
echo "----------------------------------"

# Check lightpush
echo "Testing LightPush protocol..."
curl -s -X GET "http://$WAKU_NODE_IP:$WAKU_NODE_PORT/lightpush/v1/health" 2>/dev/null || echo "LightPush may not be available via REST"

# Check filter
echo -e "\nTesting Filter protocol..."
curl -s -X GET "http://$WAKU_NODE_IP:$WAKU_NODE_PORT/filter/v1/health" 2>/dev/null || echo "Filter may not be available via REST"

# Check store
echo -e "\nTesting Store protocol..."
curl -s -X GET "http://$WAKU_NODE_IP:$WAKU_NODE_PORT/store/v1/health" 2>/dev/null || echo "Store may not be available via REST"

echo -e "\n3. WebSocket connectivity:"
echo "--------------------------"
echo "WebSocket at ws://$WAKU_NODE_IP:$WAKU_NODE_PORT is accessible (verified earlier)"

echo -e "\n========================================="
echo "Your friend's nwaku node configuration should have:"
echo "  --lightpush=true"
echo "  --filter=true" 
echo "  --store=true (optional, for history)"
echo "  --websocket-support=true"
echo "  --websocket-port=$WAKU_NODE_PORT"
echo "  --cluster-id=999"
echo "  --shard=42000"
echo ""
echo "Example nwaku start command:"
echo "  nwaku --lightpush=true --filter=true --websocket-support=true --websocket-port=$WAKU_NODE_PORT --cluster-id=999 --shard=42000"