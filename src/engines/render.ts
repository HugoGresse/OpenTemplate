import { renderSatoriPng } from './satori.js';
import { renderPuppeteerPng, renderPuppeteerPdf } from './puppeteer.js';
import { interpolate } from '../utils/interpolate.js';
import { inlineRemoteAssets } from '../utils/inline-assets.js';
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
  inlined: number;
  skipped: number;
  skippedDetails: Array<{ url: string; reason: string }>;
}

async function prepare(input: RenderInput): Promise<PreparedRender> {
  const html = interpolate(input.html, input.data);
  const css = input.css ? interpolate(input.css, input.data) : undefined;
  if (!config.inlineRemoteAssets) {
    return {
      html,
      css,
      width: input.width,
      height: input.height,
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
    height: prepared.height
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
    height: prepared.height
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
