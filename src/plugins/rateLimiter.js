import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { config } from '../config.js';

/**
 * Token-bucket rate limiter, per API key, backed by Redis.
 *
 * Each bucket holds at most `RATE_LIMIT_CAPACITY` tokens (default 100).
 * Tokens refill at a rate of capacity / windowSecs per second.
 * When the bucket is empty the request is rejected with:
 *   HTTP 429 — { error: 'rate_limit_exceeded', retryAfter: <seconds> }
 *   Retry-After: <seconds>
 *
 * The atomic Lua script ensures no race conditions between the read-modify-write
 * cycle even under concurrent requests.
 *
 * req.apiKey must be set before this hook runs (the JWT plugin sets it).
 */

const LUA_TOKEN_BUCKET = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local ratePerSec = tonumber(ARGV[2])
local nowMs     = tonumber(ARGV[3])

local data = redis.call('HMGET', key, 'tokens', 'lastMs')
local tokens  = tonumber(data[1])
local lastMs  = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  lastMs = nowMs
end

-- refill proportional to elapsed time
local elapsedSec = math.max(0, (nowMs - lastMs) / 1000)
tokens = math.min(capacity, tokens + elapsedSec * ratePerSec)

if tokens >= 1 then
  tokens = tokens - 1
  local ttlSec = math.ceil(capacity / ratePerSec) + 2
  redis.call('HMSET', key, 'tokens', tokens, 'lastMs', nowMs)
  redis.call('EXPIRE', key, ttlSec)
  return {1, math.floor(tokens), 0}
else
  -- seconds until the next token becomes available
  local retryAfter = math.ceil((1 - tokens) / ratePerSec)
  local ttlSec = math.ceil(capacity / ratePerSec) + 2
  redis.call('HMSET', key, 'tokens', tokens, 'lastMs', nowMs)
  redis.call('EXPIRE', key, ttlSec)
  return {0, 0, retryAfter}
end
`.trim();

async function plugin(fastify) {
  const redis = new Redis(config.redisUrl, { lazyConnect: true });

  try {
    await redis.connect();
  } catch (err) {
    fastify.log.warn({ err }, 'Redis connection failed — rate limiting disabled');
  }

  // Pre-load the Lua script for efficiency
  const luaSha = await redis.script('LOAD', LUA_TOKEN_BUCKET).catch(() => null);

  const ratePerSec = config.rateLimitCapacity / config.rateLimitWindowSecs;

  fastify.addHook('onRequest', async (req, reply) => {
    // skip rate limiting if Redis is not available
    if (redis.status !== 'ready') return;

    // skip public paths
    const path = req.url.split('?')[0];
    if (path === '/health') return;

    const apiKey = req.apiKey ?? req.headers['x-api-key'] ?? req.ip;
    const redisKey = `rl:${apiKey}`;
    const nowMs = Date.now();

    let result;
    try {
      if (luaSha) {
        result = await redis.evalsha(
          luaSha,
          1,
          redisKey,
          config.rateLimitCapacity,
          ratePerSec,
          nowMs,
        );
      } else {
        result = await redis.eval(
          LUA_TOKEN_BUCKET,
          1,
          redisKey,
          config.rateLimitCapacity,
          ratePerSec,
          nowMs,
        );
      }
    } catch (err) {
      fastify.log.warn({ err }, 'Rate limiter eval failed — passing request through');
      return;
    }

    const [allowed, _remaining, retryAfter] = result;

    if (!allowed) {
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({
        error: 'rate_limit_exceeded',
        retryAfter,
        message: `Rate limit of ${config.rateLimitCapacity} requests per ${config.rateLimitWindowSecs}s exceeded`,
      });
    }
  });

  fastify.addHook('onClose', async () => {
    await redis.quit().catch(() => {});
  });
}

export const rateLimiterPlugin = fp(plugin, {
  name: 'rate-limiter',
  fastify: '4.x',
});
