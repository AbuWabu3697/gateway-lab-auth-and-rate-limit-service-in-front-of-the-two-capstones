import fp from 'fastify-plugin';
import { jwtVerify, createRemoteJWKSet, errors as joseErrors } from 'jose';
import { config } from '../config.js';

/**
 * JWT verification middleware.
 *
 * Every request except /health must carry a valid Bearer token in the
 * Authorization header. The token is verified against the remote JWKS
 * endpoint; the key set is cached for jwksCacheTtlMs milliseconds.
 *
 * Error codes returned in the JSON body:
 *   missing_token  — no Authorization header or Bearer prefix absent
 *   token_expired  — signature is valid but iat/exp claim is in the past
 *   invalid_token  — any other verification failure (bad sig, wrong iss, etc.)
 *
 * On success, req.jwtPayload is set to the decoded payload and req.apiKey is
 * set to payload.sub (used by the rate limiter).
 */
async function plugin(fastify) {
  const JWKS = createRemoteJWKSet(new URL(config.jwksUri), {
    cacheMaxAge: config.jwksCacheTtlMs,
  });

  const verifyOptions = {};
  if (config.jwtIssuer) verifyOptions.issuer = config.jwtIssuer;
  if (config.jwtAudience) verifyOptions.audience = config.jwtAudience;

  // Paths that skip JWT verification
  const PUBLIC_PATHS = new Set(['/health']);

  fastify.addHook('onRequest', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0])) return;

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: 'missing_token',
        message: 'Authorization header with Bearer token required',
      });
    }

    const token = authHeader.slice(7);

    try {
      const { payload } = await jwtVerify(token, JWKS, verifyOptions);
      req.jwtPayload = payload;
      req.apiKey = payload.sub ?? 'anonymous';
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        return reply.code(401).send({
          error: 'token_expired',
          message: 'Token has expired',
        });
      }
      // JWSSignatureVerificationFailed, JWTClaimValidationFailed, etc.
      return reply.code(401).send({
        error: 'invalid_token',
        message: 'Token verification failed',
      });
    }
  });
}

export const jwtPlugin = fp(plugin, {
  name: 'jwt-verify',
  fastify: '4.x',
});
