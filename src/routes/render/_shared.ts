import type { FastifyReply } from 'fastify';
import { config } from '../../config.js';
import { renderPdf, renderPng, type RenderInput, type RenderResult } from '../../engines/render.js';
import type { FilesStore } from '../../storage/files.js';

// ---------- schemas (shared by every render route) ----------

export const renderBodySchema = {
  type: 'object',
  properties: {
    html: {
      type: 'string',
      minLength: 1,
      maxLength: 200_000,
      description:
        'HTML body. Mustache placeholders (`{{var}}`, `{{{var}}}`) substituted from `data`. ' +
        'For Satori: flexbox-only CSS subset. For Puppeteer: any HTML. ' +
        'Tag elements with `data-otid="..."` to make them targetable by `data._links`.'
    },
    css: {
      type: 'string',
      maxLength: 200_000,
      description: 'CSS injected into a <style> block. Mustache substitution applies.'
    },
    data: {
      type: 'object',
      additionalProperties: true,
      description:
        'Mustache variables. Reserved key `_links` configures hyperlinks ' +
        '(see top-level "Hyperlinks" section in the doc). `_links` is stripped ' +
        'before interpolation; the remaining keys substitute as normal.'
    },
    width: {
      type: 'number',
      minimum: 1,
      maximum: config.maxDimension,
      description: `Output width in px (1–${config.maxDimension}). width × height must be ≤ ${config.maxPixelArea}.`
    },
    height: {
      type: 'number',
      minimum: 1,
      maximum: config.maxDimension,
      description: `Output height in px (1–${config.maxDimension}).`
    },
    engine: {
      type: 'string',
      enum: ['satori', 'puppeteer', 'auto'],
      description:
        'Rendering engine. `auto` (default) tries Satori then falls back to Puppeteer ' +
        'on unsupported CSS. `puppeteer` is required for arbitrary CSS / scripts / external assets ' +
        'fetched at render time.'
    },
    timeoutMs: {
      type: 'number',
      minimum: 1_000,
      maximum: config.renderTimeoutMaxMs,
      description:
        `Per-request render timeout in ms. Defaults to RENDER_TIMEOUT_MS (30000). ` +
        `Clamped server-side to [1000, ${config.renderTimeoutMaxMs}].`
    }
  },
  required: ['html'],
  additionalProperties: false,
  examples: [
    {
      summary: 'Minimal Satori-compatible',
      value: {
        html: '<div style="display:flex;width:600px;height:300px;background:#1e88e5;color:white;align-items:center;justify-content:center;font-size:32px;">Hello {{name}}</div>',
        data: { name: 'World' },
        width: 600,
        height: 300
      }
    },
    {
      summary: 'With hyperlink (data._links)',
      value: {
        html: '<div data-otid="cta" style="display:flex;padding:20px;background:#43a047;color:white;font-size:24px;">{{label}}</div>',
        data: {
          label: 'Buy now',
          _links: { cta: { url: 'https://example.com/buy', title: 'Open store' } }
        },
        width: 400,
        height: 200,
        engine: 'auto'
      }
    },
    {
      summary: 'Puppeteer with longer timeout',
      value: {
        html: '<div class="card">{{title}}</div>',
        css: '.card { display: flex; padding: 24px; font-family: sans-serif; }',
        data: { title: 'Slow render' },
        width: 1200,
        height: 630,
        engine: 'puppeteer',
        timeoutMs: 60000
      }
    }
  ]
} as const;

export const storedRenderBodySchema = {
  type: 'object',
  properties: {
    data: {
      type: 'object',
      additionalProperties: true,
      description:
        "Per-request data. When omitted, the template's `sampleData` is used as fallback. " +
        'Reserved `_links` key applies the same way as on inline render.'
    },
    timeoutMs: {
      type: 'number',
      minimum: 1_000,
      maximum: config.renderTimeoutMaxMs,
      description: `Override global render timeout for this call. Capped at ${config.renderTimeoutMaxMs} ms.`
    }
  },
  additionalProperties: false,
  examples: [
    { summary: 'Use template sample data', value: {} },
    {
      summary: 'Override data + add link',
      value: {
        data: {
          name: 'Alice',
          _links: { cta: 'https://example.com' }
        }
      }
    }
  ]
} as const;

/**
 * Query schema accepted by every render endpoint.
 *
 * - `output` — comma-or-`+`-joined formats. Tokens: `png`, `pdf`. If omitted,
 *   the endpoint path's default applies (/render/png → png, /render/pdf →
 *   pdf, /render/bundle → png+pdf).
 * - `store` — comma-or-`+`-joined response modes. Tokens: `url`, `data`.
 *   When `url`, server writes a file and returns `{id, url, size, expiresAt}`.
 *   When `data`, returns `{data: <base64>}`. When both, returns both.
 *   Backward-compat: `true`/`1` ≡ `url`; `false`/`0` ≡ unset (legacy binary
 *   for single format, legacy base64 bundle for multi-format).
 */
export const renderQuerySchema = {
  type: 'object',
  properties: {
    output: {
      type: 'string',
      pattern: '^(png|pdf)([+\\s,]+(png|pdf))?$',
      description:
        "Comma-or-`+`-joined output formats. e.g. `png`, `pdf`, `png+pdf`. " +
        "Omit to use the endpoint's default."
    },
    store: {
      type: 'string',
      pattern: '^(url|data)([+\\s,]+(url|data))*$',
      description:
        'Response mode. Tokens: `url`, `data`. Combine with `+`, `,`, or space. ' +
        'Examples: `url`, `data`, `url+data`. Omit for default behavior (binary single, base64 bundle multi).'
    }
  },
  additionalProperties: false
} as const;

// ---------- types ----------

export interface AdHocBody {
  html: string;
  css?: string;
  data?: Record<string, unknown>;
  width?: number;
  height?: number;
  engine?: 'satori' | 'puppeteer' | 'auto';
  timeoutMs?: number;
}

export interface StoredBody {
  data?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface RenderQuery {
  output?: string;
  store?: string;
}

/** Clamp a caller-supplied timeoutMs to [1_000, RENDER_TIMEOUT_MAX_MS]. */
export function clampTimeout(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  return Math.max(1_000, Math.min(v, config.renderTimeoutMaxMs));
}

// ---------- query parsing ----------

export interface OutputFormats {
  png: boolean;
  pdf: boolean;
}

export interface StoreModes {
  url: boolean;
  data: boolean;
}

const TOKEN_SPLIT = /[+\s,]+/;

export function parseOutput(raw: string | undefined, defaultFormats: OutputFormats): OutputFormats {
  if (!raw) return defaultFormats;
  const tokens = raw
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    png: tokens.includes('png'),
    pdf: tokens.includes('pdf')
  };
}

export function parseStore(raw: string | undefined): StoreModes {
  if (!raw) return { url: false, data: false };
  const tokens = raw
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    url: tokens.includes('url'),
    data: tokens.includes('data')
  };
}

// ---------- helpers ----------

export function checkPixelArea(width: number, height: number): string | null {
  if (width * height > config.maxPixelArea) {
    return `pixel_area_exceeded:${width * height}_max:${config.maxPixelArea}`;
  }
  return null;
}

export function fallbackHeader(reason: string): string {
  return encodeURIComponent(reason.slice(0, 200));
}

export function attachAssetHeaders(reply: FastifyReply, result: RenderResult): void {
  reply.header('x-engine', result.engineUsed);
  reply.header('x-assets-inlined', String(result.assetsInlined));
  if (result.assetsSkipped > 0) {
    reply.header('x-assets-skipped', String(result.assetsSkipped));
    reply.header(
      'x-assets-skip-detail',
      fallbackHeader(result.assetsSkipDetails.map((d) => `${d.reason}:${d.url}`).join('|'))
    );
  }
  if (result.fallbackReason) {
    reply.header('x-fallback-reason', fallbackHeader(result.fallbackReason));
  }
}

// ---------- main dispatcher ----------

interface DispatchOptions {
  input: RenderInput;
  output: OutputFormats;
  store: StoreModes;
  files: FilesStore;
  width: number;
  height: number;
}

interface FormatMeta {
  ext: 'png' | 'pdf';
  result: RenderResult;
}

/**
 * Run all requested render formats in parallel, then assemble the response
 * shape based on `store` modes. Returns either:
 * - { binary: Buffer, contentType, headerMeta } for single-format with no store
 *   (legacy binary path), or
 * - { json } for everything else.
 */
export async function dispatchRender(
  opts: DispatchOptions
): Promise<
  | {
      binary: Buffer;
      contentType: string;
      headerResult: RenderResult;
    }
  | { json: Record<string, unknown> }
> {
  const tasks: Array<Promise<FormatMeta>> = [];
  if (opts.output.png) {
    tasks.push(renderPng(opts.input).then((result) => ({ ext: 'png' as const, result })));
  }
  if (opts.output.pdf) {
    tasks.push(renderPdf(opts.input).then((result) => ({ ext: 'pdf' as const, result })));
  }
  if (tasks.length === 0) {
    throw new Error('no_output_format_requested');
  }

  const results = await Promise.all(tasks);
  const single = results.length === 1;
  const wantUrl = opts.store.url;
  const wantData = opts.store.data;
  const noStore = !wantUrl && !wantData;

  // ---- single-format, no store → binary
  if (single && noStore) {
    const f = results[0]!;
    return {
      binary: f.result.buffer,
      contentType: f.ext === 'pdf' ? 'application/pdf' : 'image/png',
      headerResult: f.result
    };
  }

  // ---- JSON response
  // For multi-format with no store, default to base64 data (legacy bundle shape)
  const includeData = wantData || (!single && noStore);
  const includeUrl = wantUrl;

  // Save files in parallel where requested
  const saved = await Promise.all(
    results.map(async (f) => {
      if (!includeUrl) return null;
      return opts.files.save(f.result.buffer, f.ext, config.filesTtlSeconds);
    })
  );

  // Common per-request meta — picked from the first format (asset stats are
  // the same across formats; they're computed once during prepare()).
  const first = results[0]!.result;
  const meta: Record<string, unknown> = {
    engineUsed: single
      ? results[0]!.result.engineUsed
      : Object.fromEntries(results.map((f) => [f.ext, f.result.engineUsed])),
    width: opts.width,
    height: opts.height,
    assetsInlined: first.assetsInlined,
    assetsSkipped: first.assetsSkipped
  };
  if (first.fallbackReason) meta.fallbackReason = first.fallbackReason;

  if (single) {
    const f = results[0]!;
    const body: Record<string, unknown> = { format: f.ext, ...meta };
    const s = saved[0];
    if (s) {
      body.id = s.id;
      body.url = s.url;
      body.size = s.size;
      body.expiresAt = s.expiresAt.toISOString();
    }
    if (includeData) {
      body.data = f.result.buffer.toString('base64');
    }
    return { json: body };
  }

  // multi-format
  const formatsBlock: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < results.length; i++) {
    const f = results[i]!;
    const node: Record<string, unknown> = {};
    const s = saved[i];
    if (s) {
      node.id = s.id;
      node.url = s.url;
      node.size = s.size;
    }
    if (includeData) node.data = f.result.buffer.toString('base64');
    formatsBlock[f.ext] = node;
  }
  // Single shared expiresAt — all files in this request expire together.
  if (includeUrl && saved[0]) {
    meta.expiresAt = saved[0].expiresAt.toISOString();
  }
  return { json: { ...formatsBlock, ...meta } };
}

// ---------- route helper to send the dispatch result ----------

export async function sendRender(
  reply: FastifyReply,
  dispatch: Awaited<ReturnType<typeof dispatchRender>>
): Promise<unknown> {
  if ('binary' in dispatch) {
    reply.header('content-type', dispatch.contentType);
    attachAssetHeaders(reply, dispatch.headerResult);
    return reply.send(dispatch.binary);
  }
  return dispatch.json;
}
