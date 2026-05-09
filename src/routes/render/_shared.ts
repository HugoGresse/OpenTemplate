import type { FastifyReply } from 'fastify';
import { config } from '../../config.js';
import type { RenderResult } from '../../engines/render.js';
import type { FilesStore } from '../../storage/files.js';

// ---------- schemas (shared by every render route) ----------

export const renderBodySchema = {
  type: 'object',
  properties: {
    html: { type: 'string', minLength: 1, maxLength: 200_000 },
    css: { type: 'string', maxLength: 200_000 },
    data: { type: 'object', additionalProperties: true },
    width: { type: 'number', minimum: 1, maximum: config.maxDimension },
    height: { type: 'number', minimum: 1, maximum: config.maxDimension },
    engine: { type: 'string', enum: ['satori', 'puppeteer', 'auto'] }
  },
  required: ['html'],
  additionalProperties: false
} as const;

export const storedRenderBodySchema = {
  type: 'object',
  properties: {
    data: { type: 'object', additionalProperties: true }
  },
  additionalProperties: false
} as const;

export const storeQuerySchema = {
  type: 'object',
  properties: {
    store: { type: 'string', enum: ['true', 'false', '1', '0'] }
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
}

export interface StoredBody {
  data?: Record<string, unknown>;
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
