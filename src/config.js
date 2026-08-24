/**
 * Central config — reads from process.env with explicit development fallbacks.
 *
 * Required in production:
 *   JWKS_URI          - URL of the JWKS endpoint for JWT verification
 *   REDIS_URL         - Redis connection string
 *   LEDGER_UPSTREAM   - Base URL for the ledger service
 *   NOTIFY_UPSTREAM   - Base URL for the notifier service
 */
export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  host: process.env.HOST ?? '0.0.0.0',

  // JWT
  jwksUri: process.env.JWKS_URI ?? 'http://localhost:4000/.well-known/jwks.json',
  jwksCacheTtlMs: parseInt(process.env.JWKS_CACHE_TTL_MS ?? '300000', 10), // 5 min
  jwtAudience: process.env.JWT_AUDIENCE ?? undefined,
  jwtIssuer: process.env.JWT_ISSUER ?? undefined,

  // Rate limiting — token bucket
  rateLimitCapacity: parseInt(process.env.RATE_LIMIT_CAPACITY ?? '100', 10),
  rateLimitWindowSecs: parseInt(process.env.RATE_LIMIT_WINDOW_SECS ?? '60', 10),

  // Redis
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',

  // Upstream services
  ledgerUpstream: process.env.LEDGER_UPSTREAM ?? 'http://localhost:4001',
  notifyUpstream: process.env.NOTIFY_UPSTREAM ?? 'http://localhost:4002',

  // Circuit breaker
  cbWindowSize: parseInt(process.env.CB_WINDOW_SIZE ?? '10', 10),
  cbErrorThreshold: parseFloat(process.env.CB_ERROR_THRESHOLD ?? '0.5'),
  cbOpenDurationMs: parseInt(process.env.CB_OPEN_DURATION_MS ?? '30000', 10), // 30s
};
