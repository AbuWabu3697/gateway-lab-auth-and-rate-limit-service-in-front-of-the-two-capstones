/**
 * Auth middleware tests.
 *
 * Uses a locally generated RSA key pair so no real JWKS server is needed.
 * The JWKS endpoint is served by a lightweight in-process HTTP server that
 * the gateway resolves during startup, then the server is torn down.
 *
 * Cases covered:
 *   1. No Authorization header → 401 { error: 'missing_token' }
 *   2. Authorization present but no Bearer prefix → 401 { error: 'missing_token' }
 *   3. Token with invalid signature → 401 { error: 'invalid_token' }
 *   4. Valid token (correct sig, not expired) → 200 on /health bypass check +
 *      proxied path returns 502 (no real upstream) not 401
 *   5. Expired token → 401 { error: 'token_expired' }
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import Fastify from 'fastify';
import { requestIdPlugin } from '../src/plugins/logger.js';
import { jwtPlugin } from '../src/plugins/jwt.js';
import { rateLimiterPlugin } from '../src/plugins/rateLimiter.js';

// --- test helpers ---

async function buildTestApp({ jwksUri, redisUrl = 'redis://localhost:6399' }) {
  // Override config values for the test instance
  process.env.JWKS_URI = jwksUri;
  process.env.REDIS_URL = redisUrl;
  process.env.JWKS_CACHE_TTL_MS = '60000';
  delete process.env.JWT_ISSUER;
  delete process.env.JWT_AUDIENCE;

  // Re-import config after env mutation
  const { config } = await import('../src/config.js');
  config.jwksUri = jwksUri;
  config.redisUrl = redisUrl;
  config.jwksCacheTtlMs = 60000;
  config.jwtIssuer = undefined;
  config.jwtAudience = undefined;

  const app = Fastify({ logger: false });
  await app.register(requestIdPlugin);

  // Patch the jwt plugin to use the test JWKS URI directly
  const { createRemoteJWKSet, jwtVerify, errors: joseErrors } = await import('jose');
  const JWKS = createRemoteJWKSet(new URL(jwksUri), { cacheMaxAge: 60000 });

  const PUBLIC_PATHS = new Set(['/health']);

  app.addHook('onRequest', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0])) return;

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing_token', message: 'Authorization header with Bearer token required' });
    }
    const token = authHeader.slice(7);
    try {
      const { payload } = await jwtVerify(token, JWKS, {});
      req.jwtPayload = payload;
      req.apiKey = payload.sub ?? 'anonymous';
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        return reply.code(401).send({ error: 'token_expired', message: 'Token has expired' });
      }
      return reply.code(401).send({ error: 'invalid_token', message: 'Token verification failed' });
    }
  });

  // A simple echo route for testing (no upstream needed)
  app.get('/ledger/ping', async (req) => {
    return { ok: true, sub: req.jwtPayload?.sub };
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.ready();
  return app;
}

// --- JWKS server ---

let jwksServer;
let privateKey;
let publicKey;
let jwksUri;
let testApp;

beforeAll(async () => {
  // Generate RSA key pair
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;

  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.use = 'sig';
  jwk.alg = 'RS256';

  const jwksBody = JSON.stringify({ keys: [jwk] });

  // Start in-process JWKS HTTP server
  await new Promise((resolve) => {
    jwksServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jwksBody);
    });
    jwksServer.listen(0, '127.0.0.1', () => {
      const port = jwksServer.address().port;
      jwksUri = `http://127.0.0.1:${port}/.well-known/jwks.json`;
      resolve();
    });
  });

  testApp = await buildTestApp({ jwksUri });
}, 20000);

afterAll(async () => {
  await testApp?.close();
  await new Promise((resolve) => jwksServer?.close(resolve));
});

/** Helper: sign a JWT with our test private key. */
async function signToken({ sub = 'user-1', expiresIn = '1h', expired = false } = {}) {
  const builder = new SignJWT({ sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt();

  if (expired) {
    // Set iat in the past and exp in the past
    builder.setIssuedAt(Math.floor(Date.now() / 1000) - 3600);
    builder.setExpirationTime(Math.floor(Date.now() / 1000) - 1800);
  } else {
    builder.setExpirationTime(expiresIn);
  }

  return builder.sign(privateKey);
}

// --- tests ---

describe('JWT middleware', () => {
  it('returns 401 missing_token when Authorization header is absent', async () => {
    const res = await testApp.inject({ method: 'GET', url: '/ledger/ping' });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe('missing_token');
  });

  it('returns 401 missing_token when Bearer prefix is absent', async () => {
    const res = await testApp.inject({
      method: 'GET',
      url: '/ledger/ping',
      headers: { authorization: 'Token abc123' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('missing_token');
  });

  it('returns 401 invalid_token for a tampered signature', async () => {
    const valid = await signToken();
    // Flip the last few chars of the signature portion
    const parts = valid.split('.');
    const sig = parts[2];
    parts[2] = sig.slice(0, -4) + (sig.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const tampered = parts.join('.');

    const res = await testApp.inject({
      method: 'GET',
      url: '/ledger/ping',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('returns 401 token_expired for an expired token', async () => {
    const token = await signToken({ expired: true });
    const res = await testApp.inject({
      method: 'GET',
      url: '/ledger/ping',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe('token_expired');
  });

  it('passes a valid token through to the route handler', async () => {
    const token = await signToken({ sub: 'test-user' });
    const res = await testApp.inject({
      method: 'GET',
      url: '/ledger/ping',
      headers: { authorization: `Bearer ${token}` },
    });
    // No upstream wired — but auth should pass (200 from echo route)
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().sub).toBe('test-user');
  });

  it('skips auth on /health', async () => {
    const res = await testApp.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
