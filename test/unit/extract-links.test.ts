import { describe, it, expect, vi } from 'vitest';

// We import the module under test indirectly: extractLinksFromData is internal
// to engines/render.ts. Verify behaviour end-to-end via prepare→applyLinks
// observable through renderPng. Mock the engines so this is a fast unit-style
// integration test.

vi.mock('../../src/engines/satori.js', () => ({
  warmupSatori: async () => undefined,
  renderSatoriPng: async (opts: { html: string; css?: string }) =>
    Buffer.from(`<<SATORI:${opts.html}|css=${opts.css ?? ''}>>`)
}));

vi.mock('../../src/engines/puppeteer.js', () => ({
  shutdownPuppeteer: async () => undefined,
  warmupPuppeteer: async () => undefined,
  puppeteerStats: () => ({ pagesServed: 0, inFlight: 0, pending: 0 }),
  renderPuppeteerPng: async (opts: { html: string; css?: string }) =>
    Buffer.from(`<<PUP-PNG:${opts.html}>>`),
  renderPuppeteerPdf: async (opts: { html: string; css?: string }) =>
    Buffer.from(`<<PUP-PDF:${opts.html}>>`)
}));

import { renderPng } from '../../src/engines/render.js';

describe('data._links → applyLinks integration', () => {
  it('wraps element matched by otid using short-form data._links', async () => {
    const out = await renderPng({
      html: '<div data-otid="cta">Click</div>',
      data: { _links: { cta: 'https://example.com' } },
      width: 200,
      height: 100,
      engine: 'satori'
    });
    const text = out.buffer.toString();
    expect(text).toContain('href="https://example.com"');
    expect(text).toContain('rel="noopener noreferrer"');
  });

  it('uses long-form { url, title } when provided', async () => {
    const out = await renderPng({
      html: '<div data-otid="el1">x</div>',
      data: { _links: { el1: { url: 'https://x.com', title: 'Visit X' } } },
      width: 100,
      height: 100,
      engine: 'satori'
    });
    const text = out.buffer.toString();
    expect(text).toContain('href="https://x.com"');
    expect(text).toContain('title="Visit X"');
  });

  it('strips _links from data so it does not leak into Mustache output', async () => {
    const out = await renderPng({
      html: '<div data-otid="x">{{name}}</div>',
      data: { name: 'Alice', _links: { x: 'https://x.com' } },
      width: 100,
      height: 100,
      engine: 'satori'
    });
    const text = out.buffer.toString();
    expect(text).toContain('Alice');
    expect(text).not.toContain('_links');
  });

  it('accepts array form for backward-compat', async () => {
    const out = await renderPng({
      html: '<div data-otid="a">A</div>',
      data: { _links: [{ otid: 'a', url: 'https://a.com' }] },
      width: 100,
      height: 100,
      engine: 'satori'
    });
    expect(out.buffer.toString()).toContain('href="https://a.com"');
  });

  it('renders unchanged when _links absent', async () => {
    const out = await renderPng({
      html: '<div data-otid="cta">x</div>',
      data: { other: 1 },
      width: 100,
      height: 100,
      engine: 'satori'
    });
    expect(out.buffer.toString()).not.toContain('<a ');
  });

  it('ignores non-string url values silently', async () => {
    const out = await renderPng({
      html: '<div data-otid="a">A</div>',
      // @ts-expect-error — caller sends bad data; extractor must not crash
      data: { _links: { a: { url: 123 } } },
      width: 100,
      height: 100,
      engine: 'satori'
    });
    expect(out.buffer.toString()).not.toContain('<a ');
  });
});
