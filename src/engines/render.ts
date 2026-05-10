import { renderSatoriPng } from './satori.js';
import { renderPuppeteerPng, renderPuppeteerPdf } from './puppeteer.js';
import { interpolate } from '../utils/interpolate.js';
import { inlineRemoteAssets } from '../utils/inline-assets.js';
import { applyLinks, type TemplateLink } from '../utils/links.js';

/**
 * Pull `_links` out of the data object so it isn't sent through Mustache.
 * Accepts:
 *   - { "<otid>": "https://..." }
 *   - { "<otid>": { "url": "...", "title": "..." } }
 *   - [ { "otid": "...", "url": "...", "title": "..." }, ... ]   (passthrough)
 */
function extractLinksFromData(
  data: Record<string, unknown> | undefined
): { links: TemplateLink[]; cleanData: Record<string, unknown> | undefined } {
  if (!data || !('_links' in data)) return { links: [], cleanData: data };
  const raw = (data as Record<string, unknown>)._links;
  const cleanData = { ...data };
  delete cleanData._links;

  const links: TemplateLink[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string') {
        links.push(item as TemplateLink);
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [otid, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') {
        links.push({ otid, url: value });
      } else if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        if (typeof v.url === 'string') {
          links.push({
            otid,
            url: v.url,
            title: typeof v.title === 'string' ? v.title : undefined
          });
        }
      }
    }
  }
  return { links, cleanData };
}
import { TimeoutError } from '../utils/timeout.js';
import { config } from '../config.js';
import type { Engine } from '../storage/fs.js';

export interface RenderInput {
  html: string;
  css?: string;
  data?: Record<string, unknown>;
  width: number;
  height: number;
  engine?: Engine;
  /** Override the global render timeout for this single call. Already
   *  clamped to RENDER_TIMEOUT_MAX_MS by the route handler. */
  timeoutMs?: number;
}

export interface RenderResult {
  buffer: Buffer;
  engineUsed: 'satori' | 'puppeteer';
  format: 'png' | 'pdf';
  fallbackReason?: string;
  assetsInlined: number;
  assetsSkipped: number;
  assetsSkipDetails: Array<{ url: string; reason: string }>;
}

interface PreparedRender {
  html: string;
  css: string | undefined;
  width: number;
  height: number;
  timeoutMs?: number;
  inlined: number;
  skipped: number;
  skippedDetails: Array<{ url: string; reason: string }>;
}

async function prepare(input: RenderInput): Promise<PreparedRender> {
  // Pull _links out of data — those drive applyLinks, the rest go through
  // Mustache. Done BEFORE interpolation so {{var}} inside linked elements
  // still resolves, and BEFORE asset inlining so the wrapper <a>'s href
  // can't be confused with a CSS url().
  const { links, cleanData } = extractLinksFromData(input.data);
  const linked = applyLinks(input.html, links);

  const html = interpolate(linked.html, cleanData);
  const css = input.css ? interpolate(input.css, cleanData) : undefined;
  if (!config.inlineRemoteAssets) {
    return {
      html,
      css,
      width: input.width,
      height: input.height,
      timeoutMs: input.timeoutMs,
      inlined: 0,
      skipped: 0,
      skippedDetails: []
    };
  }
  const result = await inlineRemoteAssets(html, css, {
    allowedHosts: config.puppeteer.allowedHosts,
    allowPublic: config.puppeteer.allowPublic
  });
  return {
    html: result.html,
    css: result.css,
    width: input.width,
    height: input.height,
    timeoutMs: input.timeoutMs,
    inlined: result.inlined,
    skipped: result.skipped,
    skippedDetails: result.skippedDetails
  };
}

/**
 * Decide whether a Satori failure should trigger Puppeteer fallback.
 * - Timeouts: don't fall back (infra failure, fallback likely to time out too).
 * - CSS / parse errors from satori: do fall back.
 */
function shouldFallback(err: unknown): boolean {
  if (err instanceof TimeoutError) return false;
  return true;
}

export async function renderPng(input: RenderInput): Promise<RenderResult> {
  const prepared = await prepare(input);
  const engine: Engine = input.engine ?? 'auto';
  const opts = {
    html: prepared.html,
    css: prepared.css,
    width: prepared.width,
    height: prepared.height,
    timeoutMs: prepared.timeoutMs
  };
  const meta = {
    assetsInlined: prepared.inlined,
    assetsSkipped: prepared.skipped,
    assetsSkipDetails: prepared.skippedDetails
  };

  if (engine === 'puppeteer') {
    const buffer = await renderPuppeteerPng(opts);
    return { buffer, engineUsed: 'puppeteer', format: 'png', ...meta };
  }

  if (engine === 'satori') {
    const buffer = await renderSatoriPng(opts);
    return { buffer, engineUsed: 'satori', format: 'png', ...meta };
  }

  // auto: Satori first, fall back to Puppeteer on supported error classes
  try {
    const buffer = await renderSatoriPng(opts);
    return { buffer, engineUsed: 'satori', format: 'png', ...meta };
  } catch (err) {
    if (!shouldFallback(err)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    const buffer = await renderPuppeteerPng(opts);
    return { buffer, engineUsed: 'puppeteer', format: 'png', fallbackReason: reason, ...meta };
  }
}

/**
 * PDF rendering always uses Puppeteer — Satori produces SVG only.
 */
export async function renderPdf(input: RenderInput): Promise<RenderResult> {
  const prepared = await prepare(input);
  const buffer = await renderPuppeteerPdf({
    html: prepared.html,
    css: prepared.css,
    width: prepared.width,
    height: prepared.height,
    timeoutMs: prepared.timeoutMs
  });
  return {
    buffer,
    engineUsed: 'puppeteer',
    format: 'pdf',
    assetsInlined: prepared.inlined,
    assetsSkipped: prepared.skipped,
    assetsSkipDetails: prepared.skippedDetails
  };
}
