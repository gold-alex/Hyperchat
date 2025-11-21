# Waku Configuration Guide

## Overview

Provisions and Manage Nwaku & Relay Node (including sqlite sidecar) via Docker for Hyperchat

## Quick Start

### Local Testing

```bash
cd docker
./start-test-node.sh
```

This now boots a **dual-node** local stack:
- `nwaku-node`: LightPush + Filter + Store entrypoint on `ws://localhost:8000`, REST `http://localhost:8645`, DB `./nwaku_test_db`.
- `nwaku-relay`: helper relay peer on `ws://localhost:8100`, REST `http://localhost:8745`, DB `./nwaku_relay_test_db`.
The script prints both peer IDs so you can copy `VITE_WAKU_NODE_PEER_ID` and `PRIMARY_WAKU_PEER_ID` into the root `.env`.

### Production Deployment

```bash
cd docker

# Configure environment
cp .env.example .env
# Edit .env:
# - Set WAKU_MODE=production
# - Configure PUBLIC_IP, domains, NODE_KEY, PEER_ID
# - Set WAKU_DB_PATH=./nwaku_db

# Start with Caddy reverse proxy
docker-compose --profile production up -d
```

This starts:
- nwaku node (ports not exposed, accessed via Caddy)
- Caddy reverse proxy (ports 80, 443 for SSL/TLS)
- Production database (`./nwaku_db`)

---

## Environment Variables

### Test Mode (default)

No `.env` file needed. The script sets these automatically:

```bash
# Primary LightPush/Store node (static IP inside docker network)
WAKU_WS_PORT=8000
WAKU_REST_PORT=8645
WAKU_DB_PATH=./nwaku_test_db
NWAKU_IP=172.28.0.10

# Helper relay peer (satisfies LightPush forwarding)
WAKU_RELAY_WS_PORT=8100
WAKU_RELAY_REST_PORT=8745
WAKU_RELAY_DB_PATH=./nwaku_relay_test_db
NWAKU_RELAY_IP=172.28.0.11
PRIMARY_WAKU_PEER_ID=<copy from VITE_WAKU_NODE_PEER_ID>

PUBLIC_IP=${NWAKU_IP}  # ensures relay peers can dial the primary container
```

### Production Mode

Required in `.env`:

```bash
WAKU_MODE=production
PUBLIC_IP=your.server.public.ip
WAKU_WSS_DOMAIN=waku.yourdomain.com
WAKU_API_DOMAIN=waku-api.yourdomain.com
NODE_KEY=<generate with: openssl rand -hex 32>
WAKU_DB_PATH=./nwaku_db
```

---

## Container Architecture

### Primary service: `nwaku-node`

- **Role:** LightPush/Filter/Store entrypoint that browser extensions connect to
- **Image:** `wakuorg/nwaku:v0.36.0`
- **Configuration:** Via `WAKU_WS_PORT`, `WAKU_REST_PORT`, `NODE_KEY`, etc.
- **Database:** `WAKU_DB_PATH`
- **Ports:** 8000 (WS) + 8645 (REST) exposed in test mode

### Helper relay: `nwaku-relay`

- **Role:** Local relay-only peer so LightPush always has someone to publish to
- **Image:** `wakuorg/nwaku:v0.36.0`
- **Configuration:** Uses `PRIMARY_WAKU_PEER_ID` to dial `nwaku-node` via `--staticnode`
- **Database:** `WAKU_RELAY_DB_PATH`
- **Ports:** 8100 (WS) + 8745 (REST) exposed for diagnostics
- **Protocols:** Relay only (Filter/Store/LightPush disabled) to keep resource usage low

### Mode Behavior

| Aspect | Test Mode | Production Mode |
|--------|-----------|-----------------|
| Ports | Exposed (8000, 8645) | Hidden behind Caddy |
| Database | `./nwaku_test_db` | `./nwaku_db` |
| PUBLIC_IP | `127.0.0.1` | Your server IP |
| Domains | Not used | Required |
| SSL/TLS | None | Caddy + Let's Encrypt |
| Caddy | Not started | Started via profile |

---

## Finding Peer ID

### Test Mode

```bash
docker logs nwaku-node 2>&1 | grep "PeerID"
# OR
curl http://localhost:8645/debug/v1/info | jq -r '.enrUri'
```

### Production Mode

```bash
curl "https://${WAKU_API_DOMAIN}/debug/v1/info" | jq -r '.enrUri'
```

---

## Management Commands

### Test Mode

```bash
# Start
cd docker && ./start-test-node.sh

# View logs
docker logs -f nwaku-node

# Stop
docker-compose stop

# Restart
docker-compose restart nwaku

# Remove (keeps database)
docker-compose down

# Check database

Preferred: use the sqlite sidecar service (shares the same bind-mounted DB):

```bash
docker-compose run --rm sqlite /db/waku_messages.db \
  "SELECT contentTopic, COUNT(*) FROM messages GROUP BY contentTopic;"
```

Alternative — host sqlite3 (DB is bind-mounted):

```bash
sqlite3 ./nwaku_test_db/waku_messages.db \
  "SELECT contentTopic, COUNT(*) FROM messages GROUP BY contentTopic;"
```
```

### Production Mode

```bash
# Start (both nwaku and Caddy)
docker-compose --profile production up -d

# View logs
docker-compose --profile production logs -f

# Stop
docker-compose --profile production stop

# Restart
docker-compose --profile production restart

# Remove (keeps volumes)
docker-compose --profile production down
```

---

## REST API Queries

### Test Mode (localhost)

```bash
# Node info
curl http://localhost:8645/debug/v1/info | jq

# Store messages
curl "http://localhost:8645/store/v3/messages?contentTopics=/hl-chat/1/BTC-USD_Perps/proto" | jq

# Connected peers
curl http://localhost:8645/admin/v1/peers | jq
```

### Production Mode (via domain)

```bash
# Node info
curl "https://${WAKU_API_DOMAIN}/debug/v1/info" | jq

# Store messages
curl "https://${WAKU_API_DOMAIN}/store/v3/messages?contentTopics=/hl-chat/1/BTC-USD_Perps/proto" | jq

# Connected peers  
curl "https://${WAKU_API_DOMAIN}/admin/v1/peers" | jq
```

---

## Troubleshooting

### Node Won't Start

```bash
# Check if ports are in use
lsof -i :8000
lsof -i :8645

# View container logs
docker logs nwaku-node

# Check docker-compose logs
docker-compose logs
```

### Can't Find Peer ID

```bash
# Wait longer (node may still be starting)
sleep 10 && docker logs nwaku-node 2>&1 | grep "PeerID"

# Use REST API method
curl http://localhost:8645/debug/v1/info | jq -r '.enrUri'
```

### Database Issues

```bash
# Check database directory exists
ls -la ./nwaku_test_db  # test mode
ls -la ./nwaku_db       # production mode

# Check inside container
docker exec nwaku-node ls -la /var/db/

# Check disk space
docker exec nwaku-node df -h
```

### Production Caddy Issues

```bash
# Check Caddy logs
docker logs caddy-proxy

# Verify domains resolve
nslookup ${WAKU_WSS_DOMAIN}
nslookup ${WAKU_API_DOMAIN}

# Check certificates
docker exec caddy-proxy caddy list-certificates
```
