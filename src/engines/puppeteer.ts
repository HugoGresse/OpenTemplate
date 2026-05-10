import puppeteer, { type Browser, type Page } from 'puppeteer';
import { config } from '../config.js';
import { Semaphore } from '../utils/semaphore.js';
import { withTimeout } from '../utils/timeout.js';
import { isSafeUrl } from '../utils/network.js';

let browserPromise: Promise<Browser> | null = null;
let pagesServed = 0;
const semaphore = new Semaphore(config.puppeteer.concurrency);

function launchArgs(): string[] {
  const args = ['--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'];
  if (!config.puppeteer.sandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');
  return args;
}

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.connected) return b;
    } catch {
      // launch failed previously — fall through and relaunch
    }
    browserPromise = null;
  }
  const promise = puppeteer
    .launch({ headless: true, args: launchArgs() })
    .catch((err) => {
      // on failure, clear the cached promise so the next caller retries
      browserPromise = null;
      throw err;
    });
  browserPromise = promise;
  return promise;
}

export async function shutdownPuppeteer(): Promise<void> {
  if (!browserPromise) return;
  try {
    const b = await browserPromise.catch(() => null);
    if (b) await b.close();
  } finally {
    browserPromise = null;
    pagesServed = 0;
  }
}

async function recycleIfNeeded(): Promise<void> {
  if (pagesServed >= config.puppeteer.recyclePages) {
    await shutdownPuppeteer();
  }
}

export interface PuppeteerRenderOptions {
  html: string;
  css?: string;
  width: number;
  height: number;
  /** Override the global RENDER_TIMEOUT_MS for this single render. */
  timeoutMs?: number;
}

export async function warmupPuppeteer(): Promise<void> {
  // Eagerly launch Chromium at boot so the first user request doesn't pay
  // the ~2-5s cold start. Failures swallowed — first render will retry and
  // surface the error to the caller.
  try {
    await getBrowser();
  } catch {
    /* ignore */
  }
}

function buildDocument(opts: PuppeteerRenderOptions): string {
  const css = opts.css ?? '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { width: ${opts.width}px; height: ${opts.height}px; overflow: hidden; }
  ${css}
</style></head>
<body>${opts.html}</body></html>`;
}

async function configurePage(page: Page, timeoutMs: number): Promise<void> {
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);

  await page.setJavaScriptEnabled(config.puppeteer.allowJs);
  await page.setRequestInterception(true);

  page.on('request', (req) => {
    const url = req.url();
    if (
      isSafeUrl(url, {
        allowedHosts: config.puppeteer.allowedHosts,
        allowPublic: config.puppeteer.allowPublic
      })
    ) {
      void req.continue();
    } else {
      void req.abort('blockedbyclient');
    }
  });

  page.on('pageerror', () => {
    /* swallow runtime errors from rendered HTML — body is untrusted */
  });
}

async function withPage<T>(timeoutMs: number, fn: (page: Page) => Promise<T>): Promise<T> {
  await recycleIfNeeded();
  return semaphore.run(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    pagesServed++;
    try {
      await configurePage(page, timeoutMs);
      return await fn(page);
    } finally {
      try {
        await page.close({ runBeforeUnload: false });
      } catch {
        // ignore — page already closed or browser dead
      }
    }
  });
}

export async function renderPuppeteerPng(opts: PuppeteerRenderOptions): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? config.renderTimeoutMs;
  return withTimeout(
    withPage(timeoutMs, async (page) => {
      await page.setViewport({
        width: opts.width,
        height: opts.height,
        deviceScaleFactor: 1
      });
      await page.setContent(buildDocument(opts), {
        waitUntil: 'load',
        timeout: timeoutMs
      });
      const buf = await page.screenshot({ type: 'png', fullPage: false, captureBeyondViewport: false });
      return Buffer.from(buf);
    }),
    timeoutMs,
    'puppeteer_png'
  );
}

export async function renderPuppeteerPdf(opts: PuppeteerRenderOptions): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? config.renderTimeoutMs;
  return withTimeout(
    withPage(timeoutMs, async (page) => {
      await page.setViewport({
        width: opts.width,
        height: opts.height,
        deviceScaleFactor: 1
      });
      await page.setContent(buildDocument(opts), {
        waitUntil: 'load',
        timeout: timeoutMs
      });
      const buf = await page.pdf({
        width: `${opts.width}px`,
        height: `${opts.height}px`,
        printBackground: true,
        preferCSSPageSize: false,
        pageRanges: '1',
        margin: { top: 0, right: 0, bottom: 0, left: 0 }
      });
      return Buffer.from(buf);
    }),
    timeoutMs,
    'puppeteer_pdf'
  );
}

export function puppeteerStats() {
  return {
    pagesServed,
    inFlight: semaphore.inFlight,
    pending: semaphore.pending
  };
}
