import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { TemplateStore } from './storage/fs.js';
import { FilesStore } from './storage/files.js';
import { buildRenderRoutes } from './routes/render.js';
import { buildTemplateRoutes } from './routes/templates.js';
import { buildFilesRoutes } from './routes/files.js';
import { authPlugin } from './auth.js';
import { shutdownPuppeteer, puppeteerStats } from './engines/puppeteer.js';
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

  app.get('/', async (_req, reply) => reply.redirect('/editor/'));
  app.get('/health', async () => ({
    ok: true,
    ts: new Date().toISOString(),
    puppeteer: puppeteerStats()
  }));
  // Lightweight Prometheus-style text exposition. Public so Prom can scrape.
  app.get('/metrics', async (_req, reply) => {
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
