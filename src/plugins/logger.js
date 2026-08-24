import fp from 'fastify-plugin';
import { v4 as uuidv4 } from 'uuid';

/**
 * Generates a UUID request ID for every incoming request, attaches it to
 * req.id and to the structured log output. Downstream plugins and routes
 * forward the same ID via X-Request-Id so upstreams can correlate logs.
 */
async function plugin(fastify) {
  fastify.addHook('onRequest', async (req) => {
    req.id = req.headers['x-request-id'] ?? uuidv4();
  });
}

export const requestIdPlugin = fp(plugin, {
  name: 'request-id',
  fastify: '4.x',
});
