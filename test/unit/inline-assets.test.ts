import { describe, it, expect, vi } from 'vitest';
import { inlineRemoteAssets } from '../../src/utils/inline-assets.js';

function fakeFetch(map: Record<string, { body: Buffer; type?: string; status?: number }>) {
  return vi.fn(async (url: string) => {
    const entry = map[url];
    if (!entry) return new Response('not found', { status: 404 });
    return new Response(entry.body, {
      status: entry.status ?? 200,
      headers: { 'content-type': entry.type ?? 'image/png' }
    });
  });
}

describe('inlineRemoteAssets', () => {
  it('returns input unchanged when no external URLs', async () => {
    const html = '<div>hi</div>';
    const css = '.x { color: red; }';
    const out = await inlineRemoteAssets(html, css, { allowedHosts: [] });
    expect(out.html).toBe(html);
    expect(out.css).toBe(css);
    expect(out.inlined).toBe(0);
  });

  it('skips URLs when host not in allowlist (SSRF guard)', async () => {
    const html = '<img src="https://evil.example.com/x.png">';
    const fetchImpl = vi.fn();
    const out = await inlineRemoteAssets(html, undefined, {
      allowedHosts: [],
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.inlined).toBe(0);
    expect(out.skipped).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.html).toContain('https://evil.example.com');
  });

  it('inlines img src from allowlisted host', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = fakeFetch({ 'https://cdn.example.com/a.png': { body: png } });
    const html = '<img src="https://cdn.example.com/a.png" alt="x">';
    const out = await inlineRemoteAssets(html, undefined, {
      allowedHosts: ['cdn.example.com'],
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.inlined).toBe(1);
    expect(out.html).toContain('data:image/png;base64,');
    expect(out.html).not.toContain('cdn.example.com/a.png');
  });

  it('inlines CSS url() references', async () => {
    const png = Buffer.from('PNGDATA');
    const fetchImpl = fakeFetch({ 'https://cdn.example.com/bg.png': { body: png } });
    const css = '.card { background-image: url("https://cdn.example.com/bg.png"); }';
    const out = await inlineRemoteAssets('<div class="card"/>', css, {
      allowedHosts: ['cdn.example.com'],
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.inlined).toBe(1);
    expect(out.css).toContain('data:image/png;base64,');
  });

  it('replaces every occurrence of the same URL once fetched', async () => {
    const png = Buffer.from('XX');
    const fetchImpl = fakeFetch({ 'https://cdn.example.com/a.png': { body: png } });
    const html =
      '<div><img src="https://cdn.example.com/a.png"><img src="https://cdn.example.com/a.png"></div>';
    const out = await inlineRemoteAssets(html, undefined, {
      allowedHosts: ['cdn.example.com'],
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.html.match(/data:image\/png/g)?.length).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // dedup
  });

  it('skips assets above per-asset byte cap', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024); // > 5MB cap
    const fetchImpl = fakeFetch({ 'https://cdn.example.com/big.png': { body: big } });
    const html = '<img src="https://cdn.example.com/big.png">';
    const out = await inlineRemoteAssets(html, undefined, {
      allowedHosts: ['cdn.example.com'],
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.inlined).toBe(0);
    expect(out.skipped).toBe(1);
    expect(out.html).toContain('cdn.example.com/big.png');
  });

  it('skips assets when fetch fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    const html = '<img src="https://cdn.example.com/x.png">';
    const out = await inlineRemoteAssets(html, undefined, {
      allowedHosts: ['cdn.example.com'],
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.inlined).toBe(0);
    expect(out.skipped).toBe(1);
  });

  it('drops URLs above max-assets cap', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('x'), { status: 200 }));
    let html = '';
    for (let i = 0; i < 25; i++) html += `<img src="https://cdn.example.com/a${i}.png">`;
    const out = await inlineRemoteAssets(html, undefined, {
      allowedHosts: ['cdn.example.com'],
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.inlined).toBe(20);
    expect(out.skipped).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(20);
  });

  it('inlines from any public host when allowPublic=true', async () => {
    const png = Buffer.from('XX');
    const fetchImpl = fakeFetch({ 'https://random.site.example/x.png': { body: png } });
    const html = '<img src="https://random.site.example/x.png">';
    const out = await inlineRemoteAssets(html, undefined, {
      allowedHosts: [],
      allowPublic: true,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.inlined).toBe(1);
    expect(out.html).toContain('data:image/png;base64,');
  });

  it('still blocks private hosts even with allowPublic=true', async () => {
    const fetchImpl = vi.fn();
    const html = '<img src="http://169.254.169.254/secrets">';
    const out = await inlineRemoteAssets(html, undefined, {
      allowedHosts: [],
      allowPublic: true,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.inlined).toBe(0);
    expect(out.skipped).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-http(s) URLs in allowlist mode (defense in depth)', async () => {
    const html = '<img src="https://cdn.example.com/x.png">';
    // Although the regex only matches https?://, isSafeUrl is the real gate.
    // Confirm data: stays untouched.
    const css = '.x { background: url("data:image/png;base64,AAAA"); }';
    const fetchImpl = vi.fn();
    const out = await inlineRemoteAssets(html, css, {
      allowedHosts: [],
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.css).toContain('data:image/png;base64,AAAA');
  });
});
