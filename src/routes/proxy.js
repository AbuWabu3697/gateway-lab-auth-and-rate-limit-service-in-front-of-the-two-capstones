import fp from 'fastify-plugin';
import httpProxy from '@fastify/http-proxy';
import { config } from '../config.js';
import { CircuitBreaker } from '../plugins/circuitBreaker.js';

/**
 * Proxy routes:
 *   /ledger/*  → LEDGER_UPSTREAM
 *   /notify/*  → NOTIFY_UPSTREAM
 *
 * Each upstream has an independent circuit breaker. The breaker state is
 * checked in a preHandler hook; the response status is recorded in an
 * onResponse hook so the breaker can track 5xx rates.
 *
 * X-Request-Id is propagated to upstream via the rewriteRequestHeaders hook.
 */

const LEDGER_PREFIX = '/ledger';
const NOTIFY_PREFIX = '/notify';

async function plugin(fastify) {
  const breakers = {
    ledger: new CircuitBreaker({
      windowSize: config.cbWindowSize,
      errorThreshold: config.cbErrorThreshold,
      openDurationMs: config.cbOpenDurationMs,
      name: 'ledger',
    }),
    notify: new CircuitBreaker({
      windowSize: config.cbWindowSize,
      errorThreshold: config.cbErrorThreshold,
      openDurationMs: config.cbOpenDurationMs,
      name: 'notify',
    }),
  };

  /** Shared preHandler that checks the circuit breaker for the named upstream. */
  function circuitBreakerHook(name) {
    return async function (req, reply) {
      const cb = breakers[name];
      if (!cb.allowRequest()) {
        fastify.log.warn({ upstream: name, cb: cb.state }, 'circuit breaker open');
        return reply.code(503).send({
          error: 'upstream_unavailable',
          upstream: name,
          message: `${name} upstream circuit breaker is open`,
        });
      }
    };
  }

  /** Shared rewriteRequestHeaders that stamps X-Request-Id and X-Forwarded-For. */
  function rewriteHeaders(req, headers) {
    return {
      ...headers,
      'x-request-id': req.id,
      'x-forwarded-for': req.ip,
    };
  }

  /** onResponse hook records upstream status into the circuit breaker. */
  function recordResponse(name) {
    return function (_req, _reply, res) {
      breakers[name].record(res.statusCode >= 500);
    };
  }

  // Ledger proxy
  await fastify.register(
    async (scope) => {
      scope.addHook('preHandler', circuitBreakerHook('ledger'));
      await scope.register(httpProxy, {
        upstream: config.ledgerUpstream,
        prefix: LEDGER_PREFIX,
        rewritePrefix: LEDGER_PREFIX,
        rewriteRequestHeaders,
        onResponse: recordResponse('ledger'),
      });
    },
    { prefix: LEDGER_PREFIX },
  );

  // Notify proxy
  await fastify.register(
    async (scope) => {
      scope.addHook('preHandler', circuitBreakerHook('notify'));
      await scope.register(httpProxy, {
        upstream: config.notifyUpstream,
        prefix: NOTIFY_PREFIX,
        rewritePrefix: NOTIFY_PREFIX,
        rewriteRequestHeaders,
        onResponse: recordResponse('notify'),
      });
    },
    { prefix: NOTIFY_PREFIX },
  );

  function rewriteRequestHeaders(req, headers) {
    return rewriteHeaders(req, headers);
  }
}

export const proxyRoutes = fp(plugin, {
  name: 'proxy-routes',
  fastify: '4.x',
});
