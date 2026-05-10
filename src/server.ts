import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { TemplateStore } from './storage/fs.js';
import { FilesStore } from './storage/files.js';
import { buildRenderRoutes } from './routes/render/index.js';
import { buildTemplateRoutes } from './routes/templates/index.js';
import { buildFilesRoutes } from './routes/files/index.js';
import { authPlugin } from './auth.js';
import { shutdownPuppeteer, puppeteerStats, warmupPuppeteer } from './engines/puppeteer.js';
import { warmupSatori } from './engines/satori.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

const localRequire = createRequire(import.meta.url);

/**
 * pino-pretty is a devDependency. In production builds we prune it, but
 * NODE_ENV may not be reliably set (e.g. by some PaaS hosts), so detect at
 * runtime instead of relying on the env var alone. Plain JSON is fine for
 * prod ingestion and a safe fallback for any host that prunes devDeps.
 */
function buildLoggerTransport(): { target: string; options: Record<string, unknown> } | undefined {
  if (config.isProduction) return undefined;
  try {
    localRequire.resolve('pino-pretty');
  } catch {
    return undefined;
  }
  return { target: 'pino-pretty', options: { colorize: true } };
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers.cookie',
          '*.token',
          '*.password',
          '*.apiKey',
          '*.api_key'
        ],
        censor: '[REDACTED]'
      },
      transport: buildLoggerTransport()
    },
    bodyLimit: config.bodyLimitBytes,
    genReqId: () => `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  });

  // Security headers.
  // CSP includes 'unsafe-eval' in script-src and blob: in worker-src so the
  // self-hosted Monaco editor can run its AMD loader and spawn language workers.
  // The trade-off is acceptable because the only client that executes scripts
  // here is the editor itself, served from /editor/* on the same origin —
  // API responses are images/PDFs/JSON and aren't rendered as HTML.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // https: + http: so the design-mode iframe can load any external
        // image referenced from a template's CSS / <img>. Images are
        // passive content — low risk versus the editor UX win.
        imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
        fontSrc: ["'self'", 'data:'],
        workerSrc: ["'self'", 'blob:'],
        // PDF preview in editor renders via <iframe src="blob:...">
        frameSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' }
  });

  if (config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['content-type', 'authorization', 'x-api-key']
    });
  }

  // OpenAPI spec generated from route schemas. Mounted before routes so it
  // can pick them up via the onRoute hook.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'OpenTemplate API',
        version: '0.1.0',
        description: [
          'Generate **PNG** and **PDF** from HTML+CSS+JSON templates.',
          '',
          '## Authentication',
          'All `/render/*` and `/templates/*` endpoints require an API key, sent as either:',
          '- `x-api-key: <key>` header, or',
          '- `Authorization: Bearer <key>`',
          '',
          'Public endpoints (no key): `/health`, `/metrics`, `/editor/*`, `/files/*`, `/docs/*`.',
          '',
          '## Rendering engines',
          '- `satori` — fast, low memory, **flexbox-only CSS subset**. Cannot fetch remote URLs (use the inliner).',
          '- `puppeteer` — full Chromium, supports any CSS. Slower, higher memory. **Required for PDF.**',
          '- `auto` (default) — Satori first; on failure (unsupported CSS, etc.) falls back to Puppeteer. ',
          '  The `x-fallback-reason` response header reports the Satori error when fallback fires. ',
          '  Timeouts do **not** trigger fallback.',
          '',
          '## Hyperlinks (`data._links`)',
          'Configure clickable links by adding a reserved `_links` key to the request `data` object. ',
          'Targets match by `data-otid` (preferred — assigned by the editor\'s design mode) or any CSS selector. ',
          'Three accepted shapes:',
          '```json',
          '"data": { "_links": { "cta": "https://example.com" } }',
          '"data": { "_links": { "cta": { "url": "https://example.com", "title": "Buy" } } }',
          '"data": { "_links": [ { "otid": "cta", "url": "https://example.com", "title": "Buy" } ] }',
          '```',
          'Only `http(s)`, `mailto:`, `tel:`, and simple relative URLs allowed. `javascript:`/`data:`/`file:` rejected.',
          '`_links` is stripped from `data` before Mustache interpolation — the rest of the keys substitute normally.',
          '',
          '## Storing outputs (`?store=`)',
          'Pass `?store=url`, `?store=data`, or `?store=url+data` to control the response shape:',
          '- `url` — server writes the output to disk and returns `{id, url, size, expiresAt, ...}`',
          '- `data` — server returns `{data: <base64>, ...}` without writing a file',
          '- `url+data` — both',
          '',
          'Tokens may be combined with `+`, `,`, or whitespace. Omit the param for the legacy default ',
          '(binary body for single format, base64 bundle for multi-format). URL lifetime: ',
          '`FILES_TTL_SECONDS` (24h default). Filenames carry 16-char nanoid (~95 bits entropy) — ',
          'treat the URL as a capability token.',
          '',
          '## Per-request timeout',
          'Send `timeoutMs` (1000–`RENDER_TIMEOUT_MAX_MS`, default cap 120000) in any render body to override ',
          'the global `RENDER_TIMEOUT_MS` (default 30000). Server clamps silently — never blocks unbounded waits.',
          '',
          '## External asset inlining',
          'Server can pre-fetch http(s) `<img src>` and CSS `url(...)` references and rewrite them as ',
          '`data:` URIs before render. Required for Satori (it cannot fetch). Gated by ',
          '`PUPPETEER_ALLOWED_HOSTS` allowlist + `PUPPETEER_ALLOW_PUBLIC` flag — strict-by-default. ',
          'Response headers:',
          '- `x-assets-inlined: N` — count successfully fetched',
          '- `x-assets-skipped: N` — count blocked or failed',
          '- `x-assets-skip-detail: <reason>:<url>|...` — per-URL reasons (`blocked_by_policy`, `bad_status`, `fetch_failed`, `too_large`, `budget_exceeded`, `over_max_assets`)',
          '',
          '## Response headers (binary render mode)',
          '| Header | Meaning |',
          '|---|---|',
          '| `x-engine` | Engine that produced the output: `satori` or `puppeteer` |',
          '| `x-assets-inlined` | Successful inline-asset fetches |',
          '| `x-assets-skipped` | Skipped or failed fetches (see `x-assets-skip-detail`) |',
          '| `x-fallback-reason` | URL-encoded Satori error when auto fell back to Puppeteer |',
          '',
          '## Stored templates',
          '`POST /templates` saves an HTML+CSS+sampleData triple. `POST /render/{id}/{format}` renders it. ',
          'When the body omits `data`, the template\'s `sampleData` is used. Send your own `data` to override.'
        ].join('\n')
      },
      servers: [{ url: '/' }],
      tags: [
        { name: 'render', description: 'Render PNG / PDF / both from inline or stored templates' },
        { name: 'templates', description: 'CRUD for stored HTML+CSS+sampleData templates' },
        { name: 'files', description: 'Retrieve outputs persisted via ?store=url' },
        { name: 'system', description: 'Health and metrics' }
      ],
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', name: 'x-api-key', in: 'header' },
          bearer: { type: 'http', scheme: 'bearer' }
        }
      },
      security: [{ apiKey: [] }, { bearer: [] }]
    }
  });

  // Scalar API Reference UI. Reads the OpenAPI spec @fastify/swagger generates.
  await app.register(scalar, {
    routePrefix: '/docs',
    configuration: {
      metaData: { title: 'OpenTemplate API' },
      theme: 'default',
      hideClientButton: false,
      persistAuth: true
    }
  });

  // Scalar's UI ships an inline init <script> + bundle from CDN. Override the
  // strict CSP set by helmet for /docs/* responses only.
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/docs')) {
      reply.header(
        'content-security-policy',
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://fonts.scalar.com",
          "style-src 'self' 'unsafe-inline' https://fonts.scalar.com https://cdn.jsdelivr.net",
          "img-src 'self' data: https:",
          "font-src 'self' data: https://fonts.scalar.com",
          "connect-src 'self' https:",
          "worker-src 'self' blob:"
        ].join('; ')
      );
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.global.max,
    timeWindow: config.rateLimit.global.timeWindow
  });

  // Auth runs before any route handler. /, /health, /editor/* are public.
  await app.register(authPlugin);

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/editor/',
    decorateReply: false
  });

  app.get('/', { schema: { hide: true } }, async (_req, reply) => reply.redirect('/editor/'));
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness + Puppeteer queue snapshot',
        description:
          'Public liveness endpoint. Returns `{ok: true, ts: ISO, puppeteer: {pagesServed, inFlight, pending}}`. ' +
          'Use for load balancer + container healthchecks.'
      }
    },
    async () => ({
      ok: true,
      ts: new Date().toISOString(),
      puppeteer: puppeteerStats()
    })
  );
  // Lightweight Prometheus-style text exposition. Public so Prom can scrape.
  app.get(
    '/metrics',
    {
      schema: {
        tags: ['system'],
        summary: 'Prometheus metrics',
        description:
          'Public Prometheus text exposition. Includes per-process RSS / heap and Puppeteer ' +
          'queue counters: `opentemplate_puppeteer_pages_served_total`, ' +
          '`opentemplate_puppeteer_in_flight`, `opentemplate_puppeteer_pending`. ' +
          'Scrape interval ≥ 10s recommended.'
      }
    },
    async (_req, reply) => {
    const stats = puppeteerStats();
    const mem = process.memoryUsage();
    const lines = [
      `# HELP opentemplate_puppeteer_pages_served_total Pages served since browser start`,
      `# TYPE opentemplate_puppeteer_pages_served_total counter`,
      `opentemplate_puppeteer_pages_served_total ${stats.pagesServed}`,
      `# HELP opentemplate_puppeteer_in_flight Concurrent renders in progress`,
      `# TYPE opentemplate_puppeteer_in_flight gauge`,
      `opentemplate_puppeteer_in_flight ${stats.inFlight}`,
      `# HELP opentemplate_puppeteer_pending Renders waiting for capacity`,
      `# TYPE opentemplate_puppeteer_pending gauge`,
      `opentemplate_puppeteer_pending ${stats.pending}`,
      `# HELP process_resident_memory_bytes RSS memory usage`,
      `# TYPE process_resident_memory_bytes gauge`,
      `process_resident_memory_bytes ${mem.rss}`,
      `# HELP process_heap_used_bytes V8 heap used`,
      `# TYPE process_heap_used_bytes gauge`,
      `process_heap_used_bytes ${mem.heapUsed}`
    ];
    reply.header('content-type', 'text/plain; version=0.0.4');
    return lines.join('\n') + '\n';
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const statusCode = err.statusCode ?? 500;
    const body =
      statusCode >= 500
        ? { error: 'internal_error', requestId: req.id }
        : {
            error: err.code ?? err.name ?? 'error',
            message: err.message,
            requestId: req.id
          };
    if (statusCode >= 500) req.log.error({ err, requestId: req.id }, 'request_failed');
    else req.log.warn({ err, requestId: req.id }, 'request_rejected');
    void reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ error: 'not_found', path: req.url, requestId: req.id });
  });

  const store = new TemplateStore(config.templatesDir);
  await store.init();

  const files = new FilesStore(config.filesDir, '/files', config.filesPublicBaseUrl);
  await files.init();

  // GET /files/:filename — public, so stored renders can be loaded in
  // <img src> or shared. Auth plugin's PUBLIC_PREFIXES allowlist covers it.
  await app.register(buildFilesRoutes(files));

  // Render routes get a stricter rate limit via encapsulated context
  await app.register(async (instance) => {
    await instance.register(rateLimit, {
      max: config.rateLimit.render.max,
      timeWindow: config.rateLimit.render.timeWindow
    });
    await instance.register(buildRenderRoutes(store, files));
  });

  await app.register(buildTemplateRoutes(store));

  // Hourly TTL sweep over the files dir. unref() so it doesn't keep the
  // process alive on its own.
  const cleanup = setInterval(() => {
    files
      .cleanupOlderThan(config.filesTtlSeconds)
      .then((n) => {
        if (n > 0) app.log.info({ deleted: n }, 'files_cleanup');
      })
      .catch((err) => app.log.error({ err }, 'files_cleanup_failed'));
  }, 60 * 60 * 1000);
  cleanup.unref();
  app.addHook('onClose', async () => {
    clearInterval(cleanup);
  });

  return app;
}

async function logStorageDiagnostics(app: FastifyInstance): Promise<void> {
  const { promises: fs } = await import('node:fs');
  for (const [label, dir] of [
    ['templates', config.templatesDir],
    ['files', config.filesDir]
  ] as const) {
    try {
      const stat = await fs.stat(dir);
      const entries = await fs.readdir(dir);
      app.log.info(
        {
          dir,
          mode: (stat.mode & 0o777).toString(8),
          uid: stat.uid,
          gid: stat.gid,
          existingItems: entries.length
        },
        `storage:${label} ready`
      );
    } catch (err) {
      app.log.error({ err, dir }, `storage:${label} unreachable`);
    }
  }
}

async function main() {
  // Warm Satori font cache so first render doesn't pay the network hit
  await warmupSatori();

  const app = await buildApp();
  await logStorageDiagnostics(app);

  // Eagerly launch Chromium so the first render skips the cold-start cost
  // (~2-5s). Fire-and-forget — failures are surfaced to the actual render
  // request, not blocking server boot.
  void warmupPuppeteer().then(
    () => app.log.info('puppeteer:warm'),
    (err) => app.log.warn({ err }, 'puppeteer:warmup_failed')
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting_down');
    const grace = setTimeout(() => {
      app.log.error('shutdown_timeout — forcing exit');
      process.exit(1);
    }, 20_000);
    grace.unref();
    try {
      await app.close(); // drains in-flight requests first
      await shutdownPuppeteer();
      clearTimeout(grace);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown_failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught_exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (err) => {
    app.log.fatal({ err }, 'unhandled_rejection');
    void shutdown('unhandledRejection');
  });

  await app.listen({ port: config.port, host: config.host });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
