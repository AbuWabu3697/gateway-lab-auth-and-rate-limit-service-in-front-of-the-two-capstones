# gateway-lab

Fastify API gateway that sits in front of two backend services — **ledger** and **notify** — enforcing JWT authentication and per-key rate limiting on every inbound request.

```
                          ┌──────────────────────────────────────┐
                          │             gateway-lab              │
Internet → :443 ──────►  │  JWT verify → rate limiter → proxy   │
                          │         circuit breaker              │
                          └──────┬────────────────┬─────────────┘
                                 │                │
                    /ledger/*    ▼                ▼    /notify/*
              ┌────────────────────┐   ┌────────────────────┐
              │   ledger service   │   │  notifier service  │
              │  :8080 (internal)  │   │  :8080 (internal)  │
              └────────────────────┘   └────────────────────┘
```

Ledger and Notifier are bound to Fly.io internal DNS (`.internal` addresses) and are unreachable from the public internet. All traffic must pass through the gateway.

---

## What it does

| Layer | Detail |
|---|---|
| **JWT verification** | Bearer token validated against a remote JWKS endpoint. Keys are cached for 5 minutes (configurable). Missing, invalid, and expired tokens each return 401 with a distinct `error` code. |
| **Token-bucket rate limiter** | Per API key (`sub` claim), 100 requests per 60-second window. Atomic Lua script in Redis ensures no races. 429 response includes `Retry-After`. |
| **Proxy** | `/ledger/*` and `/notify/*` proxied to the respective upstream. `X-Request-Id` is generated on arrival and propagated to all upstreams for log correlation. |
| **Circuit breaker** | Per upstream. Trips when 5xx rate exceeds 50% over the last 10 responses. Returns 503 while open; probes for recovery after 30s. |
| **Structured logs** | pino JSON logs on every request. `requestId` field on every line. |

---

## Run locally

```bash
cp .env.example .env
# edit .env — set JWKS_URI and REDIS_URL at minimum

npm install
npm start
```

Requires a running Redis instance and an accessible JWKS endpoint.

To start a local Redis:
```bash
docker run -d -p 6379:6379 redis:7-alpine
```

---

## Environment variables

| Variable | Default | Required |
|---|---|---|
| `PORT` | `3000` | no |
| `HOST` | `0.0.0.0` | no |
| `JWKS_URI` | `http://localhost:4000/.well-known/jwks.json` | **yes** |
| `JWKS_CACHE_TTL_MS` | `300000` | no |
| `JWT_ISSUER` | *(none)* | no |
| `JWT_AUDIENCE` | *(none)* | no |
| `REDIS_URL` | `redis://localhost:6379` | **yes** |
| `RATE_LIMIT_CAPACITY` | `100` | no |
| `RATE_LIMIT_WINDOW_SECS` | `60` | no |
| `LEDGER_UPSTREAM` | `http://localhost:4001` | **yes** |
| `NOTIFY_UPSTREAM` | `http://localhost:4002` | **yes** |
| `CB_WINDOW_SIZE` | `10` | no |
| `CB_ERROR_THRESHOLD` | `0.5` | no |
| `CB_OPEN_DURATION_MS` | `30000` | no |

---

## Test

```bash
npm test
```

Vitest — no real Redis or JWKS server needed. The auth suite generates a local RSA key pair and spins up an in-process JWKS server on a random port. The rate-limit suite uses ioredis-mock with a JS shim of the token-bucket Lua script.

```
✓ test/rateLimit.test.js  (6 tests)
✓ test/auth.test.js       (6 tests)
```

---

## curl walkthrough

All examples assume the gateway is running at `https://gateway-lab.fly.dev` and you have a valid JWT in `$TOKEN`.

### Get a token (from your auth server)

```bash
TOKEN=$(curl -s -X POST https://your-auth-server/token \
  -d '{"client_id":"test","client_secret":"secret"}' \
  -H 'Content-Type: application/json' | jq -r .access_token)
```

### Missing token → 401

```bash
curl -i https://gateway-lab.fly.dev/ledger/accounts
# HTTP/2 401
# {"error":"missing_token","message":"Authorization header with Bearer token required"}
```

### Expired token → 401 with distinct code

```bash
curl -i https://gateway-lab.fly.dev/ledger/accounts \
  -H "Authorization: Bearer $EXPIRED_TOKEN"
# HTTP/2 401
# {"error":"token_expired","message":"Token has expired"}
```

### Valid request → proxied to ledger

```bash
curl -i https://gateway-lab.fly.dev/ledger/accounts \
  -H "Authorization: Bearer $TOKEN"
# HTTP/2 200
# x-request-id: 3f2a1b4c-...
# {...ledger response...}
```

### Valid request → proxied to notify

```bash
curl -i -X POST https://gateway-lab.fly.dev/notify/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"user@example.com","subject":"test"}'
# HTTP/2 200
# x-request-id: 9d8e7f6a-...
# {...notifier response...}
```

### 101st request in 60s → 429

```bash
for i in $(seq 1 101); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    https://gateway-lab.fly.dev/ledger/accounts \
    -H "Authorization: Bearer $TOKEN")
  echo "Request $i: $STATUS"
done
# Request 1-100: 200
# Request 101:   429  (Retry-After: N)
```

### Health check (no auth)

```bash
curl https://gateway-lab.fly.dev/health
# {"status":"ok","ts":"2026-08-23T18:00:00.000Z"}
```

---

## Deploy to Fly.io

```bash
fly launch --no-deploy
fly secrets set \
  JWKS_URI=https://your-auth-server/.well-known/jwks.json \
  REDIS_URL=$(fly redis create --json | jq -r .privateUrl) \
  LEDGER_UPSTREAM=http://ledger-service.internal:8080 \
  NOTIFY_UPSTREAM=http://notify-service.internal:8080
fly deploy
```

The ledger and notifier services must be deployed in the same Fly.io organization. Their `fly.toml` files should set `internal_port` and omit public-facing `[[services.ports]]` entries so they remain reachable only via the `.internal` DNS addresses.

---

## Project structure

```
src/
  config.js               env-var config with explicit development fallbacks
  index.js                Fastify entry point
  plugins/
    jwt.js                JWKS fetch + cache, Bearer token verification
    rateLimiter.js        token-bucket rate limiter (Redis Lua script)
    logger.js             request ID generation and propagation
    circuitBreaker.js     per-upstream sliding-window circuit breaker
  routes/
    proxy.js              /ledger/* and /notify/* proxy routes
test/
  auth.test.js            JWT middleware — missing / invalid / expired cases
  rateLimit.test.js       rate limiter — boundary at 100/101, window reset
Dockerfile
fly.toml
```
