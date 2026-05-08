// Load .env BEFORE zod parses process.env. Existing process.env values (e.g.
// from docker -e or test setup files) take precedence — dotenv never
// overrides what's already set.
import 'dotenv/config';
import { z } from 'zod';

const csv = (v: string | undefined) =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.string().default('development'),

  TEMPLATES_DIR: z.string().default('./templates'),
  FILES_DIR: z.string().default('./files'),
  // TTL for stored render outputs (?store=true). Default 24h.
  FILES_TTL_SECONDS: z.coerce.number().int().min(60).default(86_400),
  FILES_PUBLIC_BASE_URL: z.string().optional(),

  DEFAULT_WIDTH: z.coerce.number().int().min(1).max(8000).default(1200),
  DEFAULT_HEIGHT: z.coerce.number().int().min(1).max(8000).default(630),
  MAX_DIMENSION: z.coerce.number().int().min(1).max(16000).default(4000),
  MAX_PIXEL_AREA: z.coerce.number().int().min(1).default(4_000_000),
  MAX_NAME_LEN: z.coerce.number().int().min(1).default(200),

  RL_GLOBAL_MAX: z.coerce.number().int().min(1).default(120),
  RL_RENDER_MAX: z.coerce.number().int().min(1).default(60),

  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),

  RENDER_TIMEOUT_MS: z.coerce.number().int().min(500).default(15_000),
  PUPPETEER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  PUPPETEER_SANDBOX: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('true'),
  PUPPETEER_ALLOWED_HOSTS: z.string().optional(),
  PUPPETEER_ALLOW_JS: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('false'),
  // When true, Puppeteer (and the inliner) may fetch ANY public host. Private
  // IPs / loopback / cloud-metadata addresses are still blocked. Use this in
  // dev or when you don't want to maintain PUPPETEER_ALLOWED_HOSTS.
  PUPPETEER_ALLOW_PUBLIC: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('false'),
  PUPPETEER_RECYCLE_PAGES: z.coerce.number().int().min(1).default(200),

  INLINE_REMOTE_ASSETS: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('true'),

  FONT_URL: z
    .string()
    .url()
    .default('https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.ttf'),

  API_KEYS: z.string().optional(),
  AUTH_REQUIRED: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('true'),

  CORS_ORIGINS: z.string().optional()
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  port: env.PORT,
  host: env.HOST,
  logLevel: env.LOG_LEVEL,
  isProduction: env.NODE_ENV === 'production',

  templatesDir: env.TEMPLATES_DIR,
  filesDir: env.FILES_DIR,
  filesTtlSeconds: env.FILES_TTL_SECONDS,
  filesPublicBaseUrl: env.FILES_PUBLIC_BASE_URL,

  defaultWidth: env.DEFAULT_WIDTH,
  defaultHeight: env.DEFAULT_HEIGHT,
  maxDimension: env.MAX_DIMENSION,
  maxPixelArea: env.MAX_PIXEL_AREA,
  maxNameLen: env.MAX_NAME_LEN,

  rateLimit: {
    global: { max: env.RL_GLOBAL_MAX, timeWindow: '1 minute' },
    render: { max: env.RL_RENDER_MAX, timeWindow: '1 minute' }
  },

  bodyLimitBytes: env.BODY_LIMIT_BYTES,

  renderTimeoutMs: env.RENDER_TIMEOUT_MS,

  puppeteer: {
    concurrency: env.PUPPETEER_CONCURRENCY,
    sandbox: env.PUPPETEER_SANDBOX,
    allowedHosts: csv(env.PUPPETEER_ALLOWED_HOSTS),
    allowPublic: env.PUPPETEER_ALLOW_PUBLIC,
    allowJs: env.PUPPETEER_ALLOW_JS,
    recyclePages: env.PUPPETEER_RECYCLE_PAGES
  },

  inlineRemoteAssets: env.INLINE_REMOTE_ASSETS,

  fontUrl: env.FONT_URL,

  auth: {
    keys: csv(env.API_KEYS),
    required: env.AUTH_REQUIRED
  },

  corsOrigins: csv(env.CORS_ORIGINS)
} as const;

export type Config = typeof config;
