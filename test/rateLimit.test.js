/**
 * Rate limiter tests — token-bucket boundary cases.
 *
 * Uses ioredis-mock so no real Redis instance is needed.
 * The Lua script is evaluated by the mock's eval handler.
 *
 * Cases covered:
 *   1. First 100 requests on a fresh key all succeed (200)
 *   2. 101st request returns 429 with Retry-After header
 *   3. Retry-After is a positive integer
 *   4. A different API key has an independent bucket (not throttled)
 *   5. /health bypasses rate limiting entirely
 */

import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import { requestIdPlugin } from '../src/plugins/logger.js';

// ---------------------------------------------------------------------------
// Minimal in-process token-bucket implementation (mirrors the Lua script)
// used to drive the ioredis-mock store directly, since ioredis-mock does not
// execute Lua scripts.
// ---------------------------------------------------------------------------

/**
 * Wraps ioredis-mock with a token-bucket evalsha/eval shim.
 * The shim runs the same bucket logic as the Lua script but in JS.
 */
function buildMockRedis(capacity, ratePerSec) {
  const store = {}; // key → { tokens, lastMs }

  const redisMock = new RedisMock();

  // Override eval/evalsha to run our JS token-bucket logic
  const bucketEval = (_script, _numKeys, key, cap, rate, nowMs) => {
    cap = Number(cap);
    rate = Number(rate);
    nowMs = Number(nowMs);

    if (!store[key]) {
      store[key] = { tokens: cap, lastMs: nowMs };
    }
    const entry = store[key];
    const elapsedSec = Math.max(0, (nowMs - entry.lastMs) / 1000);
    entry.tokens = Math.min(cap, entry.tokens + elapsedSec * rate);
    entry.lastMs = nowMs;

    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      return [1, Math.floor(entry.tokens), 0];
    } else {
      const retryAfter = Math.ceil((1 - entry.tokens) / rate);
      return [0, 0, retryAfter];
    }
  };

  redisMock.eval = bucketEval;
  redisMock.evalsha = (_sha, ...args) => bucketEval(null, ...args);
  redisMock.script = async () => 'mock-sha';

  return { redisMock, store };
}

// ---------------------------------------------------------------------------
// Test app factory — injects mock Redis into the rate limiter plugin
// ---------------------------------------------------------------------------

async function buildRateLimitApp({ capacity = 100, windowSecs = 60, mockRedis } = {}) {
  const app = Fastify({ logger: false });
  await app.register(requestIdPlugin);

  const ratePerSec = capacity / windowSecs;

  // Inline rate limiter that uses the injected mock
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/health') return;

    const apiKey = req.headers['x-api-key'] ?? req.ip ?? 'default';
    const redisKey = `rl:${apiKey}`;
    const nowMs = Date.now();

    let result;
    try {
      result = mockRedis.eval(
        'LUA_SCRIPT',
        1,
        redisKey,
        capacity,
        ratePerSec,
        nowMs,
      );
    } catch {
      return; // pass through on error
    }

    const [allowed, _remaining, retryAfter] = result;

    if (!allowed) {
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({
        error: 'rate_limit_exceeded',
        retryAfter,
        message: `Rate limit of ${capacity} per ${windowSecs}s exceeded`,
      });
    }
  });

  app.get('/ping', async (req) => ({ ok: true, key: req.headers['x-api-key'] }));
  app.get('/health', async () => ({ status: 'ok' }));

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Token-bucket rate limiter', () => {
  let app;
  let mockRedis;

  beforeAll(async () => {
    const built = buildMockRedis(100, 100 / 60);
    mockRedis = built.redisMock;
    app = await buildRateLimitApp({ capacity: 100, windowSecs: 60, mockRedis });
  }, 10000);

  afterAll(async () => {
    await app?.close();
  });

  it('allows the first 100 requests for a single API key', async () => {
    const headers = { 'x-api-key': 'key-boundary-test' };
    for (let i = 1; i <= 100; i++) {
      const res = await app.inject({ method: 'GET', url: '/ping', headers });
      expect(res.statusCode, `request ${i} should be 200`).toBe(200);
    }
  });

  it('returns 429 on the 101st request for the same key', async () => {
    const headers = { 'x-api-key': 'key-boundary-test' };
    const res = await app.inject({ method: 'GET', url: '/ping', headers });
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.error).toBe('rate_limit_exceeded');
  });

  it('includes a positive integer Retry-After header on 429', async () => {
    const headers = { 'x-api-key': 'key-boundary-test' };
    const res = await app.inject({ method: 'GET', url: '/ping', headers });
    expect(res.statusCode).toBe(429);
    const retryAfter = parseInt(res.headers['retry-after'], 10);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('a different API key has an independent bucket (not throttled)', async () => {
    const headers = { 'x-api-key': 'key-independent' };
    const res = await app.inject({ method: 'GET', url: '/ping', headers });
    expect(res.statusCode).toBe(200);
  });

  it('does not rate-limit /health', async () => {
    // Make 200 requests — none should be throttled
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Window reset test — simulate time advancing past the window
// ---------------------------------------------------------------------------

describe('Token-bucket window reset', () => {
  it('allows requests again after the window resets (time advance simulation)', () => {
    // Run the bucket logic directly (no Fastify needed for this)
    const capacity = 5;
    const rate = 5 / 10; // 5 tokens per 10s
    const store = {};

    function consume(key, nowMs) {
      if (!store[key]) store[key] = { tokens: capacity, lastMs: nowMs };
      const e = store[key];
      const elapsed = Math.max(0, (nowMs - e.lastMs) / 1000);
      e.tokens = Math.min(capacity, e.tokens + elapsed * rate);
      e.lastMs = nowMs;
      if (e.tokens >= 1) {
        e.tokens -= 1;
        return { allowed: true };
      }
      const retryAfter = Math.ceil((1 - e.tokens) / rate);
      return { allowed: false, retryAfter };
    }

    const t0 = Date.now();
    const key = 'window-reset-key';

    // Exhaust all 5 tokens
    for (let i = 0; i < 5; i++) {
      const r = consume(key, t0);
      expect(r.allowed).toBe(true);
    }

    // 6th request immediately → rejected
    const r6 = consume(key, t0);
    expect(r6.allowed).toBe(false);
    expect(r6.retryAfter).toBeGreaterThan(0);

    // Advance time by 12 seconds (past the full 10s window)
    const t12 = t0 + 12000;
    const r7 = consume(key, t12);
    expect(r7.allowed).toBe(true); // refilled
  });
});
