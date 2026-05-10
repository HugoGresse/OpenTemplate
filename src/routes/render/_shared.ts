import type { FastifyReply } from 'fastify';
import { config } from '../../config.js';
import type { RenderResult } from '../../engines/render.js';
import type { FilesStore } from '../../storage/files.js';

// ---------- schemas (shared by every render route) ----------
//
// Hyperlinks are configured via the JSON `data._links` key, NOT a top-level
// `links` field. Caller payload:
//   "data": { "_links": { "el3": "https://example.com" } }
// or full form:
//   "data": { "_links": { "el3": { "url": "...", "title": "..." } } }

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
        'Per-request data. When omitted, the template\'s `sampleData` is used as fallback. ' +
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

export const storeQuerySchema = {
  type: 'object',
  properties: {
    store: {
      type: 'string',
      enum: ['true', 'false', '1', '0'],
      description:
        'When `true` or `1`, server writes the rendered output to /data/files and the response is a ' +
        'JSON object `{id, url, format, engineUsed, width, height, size, expiresAt, …}` — NOT the ' +
        'binary. URL is public for `FILES_TTL_SECONDS` (default 24h).'
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

/** Clamp a caller-supplied timeoutMs to [1_000, RENDER_TIMEOUT_MAX_MS]. */
export function clampTimeout(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  return Math.max(1_000, Math.min(v, config.renderTimeoutMaxMs));
}

export interface StoreQuery {
  store?: string;
}

// ---------- helpers ----------

export function shouldStore(query: StoreQuery | undefined): boolean {
  const v = query?.store;
  return v === 'true' || v === '1';
}

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

// ---------- store-mode response builders ----------

export interface SingleStoreResponse {
  id: string;
  url: string;
  format: 'png' | 'pdf';
  engineUsed: 'satori' | 'puppeteer';
  width: number;
  height: number;
  size: number;
  expiresAt: string;
  assetsInlined: number;
  assetsSkipped: number;
  fallbackReason: string | null;
}

export async function buildSingleStoreResponse(
  files: FilesStore,
  result: RenderResult,
  ext: 'png' | 'pdf',
  width: number,
  height: number
): Promise<SingleStoreResponse> {
  const stored = await files.save(result.buffer, ext, config.filesTtlSeconds);
  return {
    id: stored.id,
    url: stored.url,
    format: ext,
    engineUsed: result.engineUsed,
    width,
    height,
    size: stored.size,
    expiresAt: stored.expiresAt.toISOString(),
    assetsInlined: result.assetsInlined,
    assetsSkipped: result.assetsSkipped,
    fallbackReason: result.fallbackReason ?? null
  };
}

export async function bundleResponse(
  files: FilesStore,
  png: RenderResult,
  pdf: RenderResult,
  width: number,
  height: number,
  store: boolean
) {
  if (store) {
    const [pngFile, pdfFile] = await Promise.all([
      files.save(png.buffer, 'png', config.filesTtlSeconds),
      files.save(pdf.buffer, 'pdf', config.filesTtlSeconds)
    ]);
    return {
      png: { id: pngFile.id, url: pngFile.url, size: pngFile.size },
      pdf: { id: pdfFile.id, url: pdfFile.url, size: pdfFile.size },
      engineUsed: { png: png.engineUsed, pdf: pdf.engineUsed },
      fallbackReason: png.fallbackReason ?? null,
      assetsInlined: png.assetsInlined,
      assetsSkipped: png.assetsSkipped,
      expiresAt: pngFile.expiresAt.toISOString(),
      width,
      height
    };
  }
  return {
    png: png.buffer.toString('base64'),
    pdf: pdf.buffer.toString('base64'),
    engineUsed: { png: png.engineUsed, pdf: pdf.engineUsed },
    fallbackReason: png.fallbackReason ?? null,
    assetsInlined: png.assetsInlined,
    assetsSkipped: png.assetsSkipped,
    width,
    height
  };
}
