# Testing Guide for Hyperchat

This guide covers both manual and automated testing of the Waku integration.

## Quick Start

### 1. Start Test Node

```bash
cd docker
./start-test-node.sh
```

This will:
- Start nwaku node via docker-compose in test mode
- Display the Peer ID
- Show values to add to project root `.env` file
- Use test database (`nwaku_test_db`)

### 2. Configure Environment

Create it manually:

```bash
VITE_WAKU_NODE_URI=localhost
VITE_WAKU_NODE_PORT=8000
VITE_WAKU_NODE_PEER_ID=<peer-id-from-script>
```

**Note:** The `.env` file should be in the project root, not in the `docker/` directory.

### 3. Build Extension

```bash
pnpm build
```

### 4. Load in Chrome

1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `dist/chrome-mv3`

## Manual Testing

See `docs/waku-integration-testing.md` for detailed manual test procedures covering:

- Connection establishment
- Protocol detection
- Historical message loading
- Real-time subscriptions
- Message sending
- Cross-tab communication
- Room switching
- Wallet integration
- Fallback behavior

## Automated Testing

### Run Integration Tests

```bash
# Make sure test node is running first
cd docker && ./start-test-node.sh && cd ..

# Run tests
pnpm test __tests__/waku-integration.test.ts

# With coverage
pnpm test:coverage __tests__/waku-integration.test.ts
```

### Test Structure

The integration test suite covers:

- **Configuration**: Environment setup and class availability
- **Client Initialization**: Connection and shard configuration
- **Content Topics**: Room-based topic generation
- **Store Protocol**: Historical message loading
- **Filter Protocol**: Real-time message subscription
- **Wallet Management**: Address and name handling
- **Error Handling**: Graceful degradation
- **Cleanup**: Proper disconnection

## Monitoring Test Node

### View Logs

```bash
docker logs -f nwaku-test
```

### Query REST API

```bash
# Node info
curl http://localhost:8645/debug/v1/info | jq

# Store messages
curl "http://localhost:8645/store/v3/messages?contentTopics=/hl-chat/1/BTC-USD_Perps/proto" | jq

# Connected peers
curl http://localhost:8645/admin/v1/peers | jq
```

### Check Database

Preferred: use the sqlite sidecar service (shares the same bind-mounted DB):

```bash
# Message count
docker-compose run --rm sqlite /db/waku_messages.db \
  "SELECT COUNT(*) FROM messages WHERE contentTopic LIKE '%hl-chat%';"

# Messages by topic
docker-compose run --rm sqlite /db/waku_messages.db \
  "SELECT contentTopic, COUNT(*) FROM messages GROUP BY contentTopic;"

# Alternative: host sqlite3 (DB is bind-mounted)
sqlite3 ./docker/nwaku_test_db/waku_messages.db \
  "SELECT COUNT(*) FROM messages WHERE contentTopic LIKE '%hl-chat%';"
sqlite3 ./docker/nwaku_test_db/waku_messages.db \
  "SELECT contentTopic, COUNT(*) FROM messages GROUP BY contentTopic;"
```

## Debugging

### Extension Console

Open DevTools in the extension context:

1. Go to `chrome://extensions/`
2. Find "Hyperchat"
3. Click "background page" (for service worker)
4. Or inspect the page where content script runs

### Useful Filters

In DevTools Console, filter by:
- `Waku` - All Waku logs
- `hl-chat` - Chat-specific logs
- `DEBUG:` - Detailed debugging

### Common Issues

#### "Failed to connect to any bootstrap peers"

**Solution:**
1. Verify node is running: `docker ps | grep nwaku-test`
2. Check peer ID matches: `docker logs nwaku-test 2>&1 | grep PeerID`
3. Update `.env` and rebuild

#### "Timeout waiting for peer that supports Store"

**Solution:**
1. Wait 20-30 seconds after starting node
2. Check protocols in logs: `docker logs nwaku-test | grep "store"`
3. Restart node: `docker restart nwaku-test`

#### TypeScript errors in content.ts

**Status:** Pre-existing WXT type definition issue, safe to ignore
**Impact:** None - code works correctly at runtime

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Waku Integration Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      nwaku:
        image: wakuorg/nwaku:v0.36.0
        ports:
          - 8000:8000
          - 8645:8645
        options: >-
          --health-cmd "curl -f http://localhost:8645/debug/v1/info || exit 1"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: pnpm/action-setup@v2
        with:
          version: 8
      
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'pnpm'
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Get nwaku peer ID
        run: |
          PEER_ID=$(curl http://localhost:8645/debug/v1/info | jq -r '.enrUri' | cut -d'/' -f7)
          echo "VITE_WAKU_NODE_PEER_ID=$PEER_ID" >> $GITHUB_ENV
      
      - name: Run integration tests
        env:
          VITE_WAKU_NODE_URI: localhost
          VITE_WAKU_NODE_PORT: 8000
        run: pnpm test __tests__/waku-integration.test.ts
```

## Test Coverage Goals

- **Unit Tests**: 80%+ coverage for pure logic
- **Integration Tests**: All Waku operations functional
- **Manual Tests**: All UI flows work end-to-end

Current coverage: Run `pnpm test:coverage` to see latest

## Cleanup

### Stop Test Node

```bash
cd docker
docker-compose stop
# Or to remove completely (keeps database)
docker-compose down
```

### Clean Build Artifacts

```bash
pnpm clean
```

## Next Steps

After successful testing:

1. ✅ All manual tests pass
2. ✅ All automated tests pass
3. 📝 Document any issues found
4. 🚀 Deploy to production nwaku node
5. 📊 Set up monitoring and alerting

## Additional Resources

- **Waku Documentation**: https://docs.waku.org
- **Integration Testing Guide**: `docs/waku-integration-testing.md`
- **WXT Migration Fixes**: `docs/waku-wxt-migration-fixes.md`
- **Waku Compatibility**: `docs/waku-dev.md`
