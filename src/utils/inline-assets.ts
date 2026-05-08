import { Semaphore } from './semaphore.js';
import { withTimeout, TimeoutError } from './timeout.js';
import { isSafeUrl } from './network.js';

/**
 * Walk HTML + CSS, find external http(s) URLs (img src, CSS url()), fetch
 * them server-side, and rewrite the source with inline `data:` URIs.
 *
 * Why: Satori cannot fetch remote images on its own — only data: URIs are
 * supported. Pre-inlining lets the same template render under both Satori
 * and Puppeteer with no engine-specific authoring rules.
 *
 * SSRF: gated by the same allowlist used by Puppeteer's request interceptor
 * (`PUPPETEER_ALLOWED_HOSTS`). With an empty allowlist nothing is fetched
 * and the original URL is left in place — the rendering engine will then
 * either block or fetch it according to its own policy.
 *
 * Resource limits: per-asset and total byte caps, max-N urls, per-fetch
 * timeout, total wall-clock budget. A misbehaving template can never
 * blow up the request beyond these bounds.
 */

const URL_RE = /url\(\s*['"]?(https?:\/\/[^)'"]+)['"]?\s*\)/gi;
const IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi;

const FETCH_TIMEOUT_MS = 4_000;
const TOTAL_BUDGET_MS = 6_000;
const MAX_PER_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ASSETS = 20;
const FETCH_CONCURRENCY = 4;

export interface InlineSkipReason {
  url: string;
  reason:
    | 'blocked_by_policy'
    | 'fetch_failed'
    | 'bad_status'
    | 'too_large'
    | 'budget_exceeded'
    | 'over_max_assets';
}

export interface InlineResult {
  html: string;
  css: string | undefined;
  inlined: number;
  skipped: number;
  skippedDetails: InlineSkipReason[];
  bytesFetched: number;
}

export interface InlineOptions {
  allowedHosts: readonly string[];
  /** When true, any public host is allowed (matches Puppeteer behaviour). */
  allowPublic?: boolean;
  fetchImpl?: typeof fetch;
}

function collectUrls(html: string, css?: string): Set<string> {
  const urls = new Set<string>();
  const add = (str: string, re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(str)) !== null) {
      const url = m[1];
      if (url) urls.add(url);
    }
  };
  add(html, IMG_SRC_RE);
  add(html, URL_RE);
  if (css) add(css, URL_RE);
  return urls;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function inlineRemoteAssets(
  html: string,
  css: string | undefined,
  options: InlineOptions
): Promise<InlineResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const allUrls = [...collectUrls(html, css)];
  if (allUrls.length === 0) {
    return { html, css, inlined: 0, skipped: 0, skippedDetails: [], bytesFetched: 0 };
  }

  const skippedDetails: InlineSkipReason[] = [];
  const skip = (url: string, reason: InlineSkipReason['reason']) => {
    skippedDetails.push({ url, reason });
  };

  let urls = allUrls;
  if (urls.length > MAX_ASSETS) {
    for (const overflow of urls.slice(MAX_ASSETS)) skip(overflow, 'over_max_assets');
    urls = urls.slice(0, MAX_ASSETS);
  }

  const sem = new Semaphore(FETCH_CONCURRENCY);
  const map = new Map<string, string>();
  let totalBytes = 0;
  let inlined = 0;
  const attempted = new Set<string>();

  const fetchOne = async (url: string): Promise<void> => {
    attempted.add(url);
    if (
      !isSafeUrl(url, {
        allowedHosts: options.allowedHosts,
        allowPublic: options.allowPublic
      })
    ) {
      skip(url, 'blocked_by_policy');
      return;
    }
    try {
      const res = await withTimeout(
        fetchImpl(url, { redirect: 'follow' }),
        FETCH_TIMEOUT_MS,
        'asset_fetch'
      );
      if (!res.ok) {
        skip(url, 'bad_status');
        return;
      }
      const advertised = Number(res.headers.get('content-length') ?? 0);
      if (advertised > MAX_PER_ASSET_BYTES) {
        skip(url, 'too_large');
        return;
      }
      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      if (buf.byteLength > MAX_PER_ASSET_BYTES) {
        skip(url, 'too_large');
        return;
      }
      if (totalBytes + buf.byteLength > MAX_TOTAL_BYTES) {
        skip(url, 'budget_exceeded');
        return;
      }
      totalBytes += buf.byteLength;
      const ct =
        res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream';
      map.set(url, `data:${ct};base64,${buf.toString('base64')}`);
      inlined++;
    } catch {
      skip(url, 'fetch_failed');
    }
  };

  try {
    await withTimeout(
      Promise.all(urls.map((u) => sem.run(() => fetchOne(u)))),
      TOTAL_BUDGET_MS,
      'inline_total'
    );
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
    for (const url of urls) {
      if (!attempted.has(url) && !map.has(url)) skip(url, 'budget_exceeded');
    }
  }

  let outHtml = html;
  let outCss = css;
  for (const [src, data] of map) {
    const re = new RegExp(escapeRegex(src), 'g');
    outHtml = outHtml.replace(re, data);
    if (outCss) outCss = outCss.replace(re, data);
  }
  return {
    html: outHtml,
    css: outCss,
    inlined,
    skipped: skippedDetails.length,
    skippedDetails,
    bytesFetched: totalBytes
  };
}
