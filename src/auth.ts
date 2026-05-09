import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from './config.js';

const PUBLIC_PATHS = new Set<string>(['/', '/health', '/metrics']);
// /files/ is public so stored render outputs can be embedded in <img>, shared
// links, etc. Filenames carry 16-char nanoid (~95 bits) so brute force is
// infeasible — treat the URL as a capability token.
// /docs is public so callers can read the OpenAPI spec without an API key
// (the spec doesn't reveal secrets; the try-it-out UI prompts for the key).
const PUBLIC_PREFIXES = ['/editor/', '/files/', '/docs'];

function extractKey(req: FastifyRequest): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return undefined;
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const isPublic = (url: string): boolean => {
  // Strip query string before matching
  const path = url.split('?')[0] ?? url;
  if (PUBLIC_PATHS.has(path)) return true;
  return PUBLIC_PREFIXES.some((p) => path.startsWith(p));
};

const authPluginInner: FastifyPluginAsync = async (app) => {
  if (!config.auth.required) {
    app.log.warn('AUTH_REQUIRED=false — all endpoints are open. Do not run in production.');
    return;
  }
  if (config.auth.keys.length === 0) {
    throw new Error(
      'AUTH_REQUIRED is true but API_KEYS is empty. Set API_KEYS to a comma-separated list of keys.'
    );
  }

  app.addHook('onRequest', async (req, reply) => {
    if (isPublic(req.url)) return;

    const key = extractKey(req);
    if (!key) {
      reply.code(401).send({ error: 'unauthorized', message: 'missing_api_key' });
      return reply;
    }
    const ok = config.auth.keys.some((valid) => timingSafeEq(key, valid));
    if (!ok) {
      reply.code(401).send({ error: 'unauthorized', message: 'invalid_api_key' });
      return reply;
    }
  });
};

export const authPlugin = fp(authPluginInner, { name: 'auth' });
