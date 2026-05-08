import satori from 'satori';
import { html as satoriHtml } from 'satori-html';
import { Resvg } from '@resvg/resvg-js';
import juice from 'juice';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../config.js';
import { withTimeout } from '../utils/timeout.js';

let fontPromise: Promise<ArrayBuffer> | null = null;

async function loadFontUncached(): Promise<ArrayBuffer> {
  const cachePath = path.join(os.tmpdir(), 'opentemplate-font-400.ttf');
  try {
    const buf = await fs.readFile(cachePath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    // not cached
  }
  const res = await fetch(config.fontUrl);
  if (!res.ok) throw new Error(`font_fetch_failed:${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  await fs.writeFile(cachePath, Buffer.from(arrayBuf), { mode: 0o600 });
  return arrayBuf;
}

async function loadFont(): Promise<ArrayBuffer> {
  if (fontPromise) {
    try {
      return await fontPromise;
    } catch {
      // previous attempt failed — clear and retry on next call
      fontPromise = null;
    }
  }
  fontPromise = loadFontUncached().catch((err) => {
    fontPromise = null;
    throw err;
  });
  return fontPromise;
}

/**
 * Preload font at boot so the first render request doesn't pay the network hit.
 * Failures are swallowed — first render will retry and surface the error to the caller.
 */
export async function warmupSatori(): Promise<void> {
  try {
    await loadFont();
  } catch {
    // ignore — boot continues
  }
}

export interface SatoriRenderOptions {
  html: string;
  css?: string;
  width: number;
  height: number;
}

export async function renderSatoriPng(opts: SatoriRenderOptions): Promise<Buffer> {
  return withTimeout(
    (async () => {
      const font = await loadFont();
      const styleTag = opts.css ? `<style>${opts.css}</style>` : '';
      const inlined = juice(`${styleTag}${opts.html}`, {
        removeStyleTags: true,
        preserveImportant: true
      });
      const node = satoriHtml(inlined);
      const svg = await satori(node as Parameters<typeof satori>[0], {
        width: opts.width,
        height: opts.height,
        fonts: [
          {
            name: 'Inter',
            data: font,
            weight: 400,
            style: 'normal'
          }
        ]
      });
      const resvg = new Resvg(svg, {
        fitTo: { mode: 'width', value: opts.width }
      });
      return Buffer.from(resvg.render().asPng());
    })(),
    config.renderTimeoutMs,
    'satori_png'
  );
}
