import { describe, it, expect } from 'vitest';
import { applyLinks, isSafeLinkUrl } from '../../src/utils/links.js';

describe('isSafeLinkUrl', () => {
  it('allows http and https', () => {
    expect(isSafeLinkUrl('http://example.com')).toBe(true);
    expect(isSafeLinkUrl('https://example.com/path?q=1')).toBe(true);
  });

  it('allows mailto and tel', () => {
    expect(isSafeLinkUrl('mailto:hi@example.com')).toBe(true);
    expect(isSafeLinkUrl('tel:+15551234')).toBe(true);
  });

  it('rejects javascript: and data:', () => {
    expect(isSafeLinkUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeLinkUrl('data:text/html,<script>x</script>')).toBe(false);
    expect(isSafeLinkUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeLinkUrl('file:///etc/passwd')).toBe(false);
  });

  it('allows simple relative URLs', () => {
    expect(isSafeLinkUrl('/path')).toBe(true);
    expect(isSafeLinkUrl('#anchor')).toBe(true);
    expect(isSafeLinkUrl('foo/bar')).toBe(true);
  });
});

describe('applyLinks', () => {
  it('returns input unchanged when links is empty', () => {
    const html = '<div data-otid="el1">Hi</div>';
    const r = applyLinks(html, []);
    expect(r.html).toBe(html);
    expect(r.applied).toBe(0);
  });

  it('wraps element matched by otid', () => {
    const html = '<div data-otid="el1">Click me</div>';
    const r = applyLinks(html, [{ otid: 'el1', url: 'https://example.com' }]);
    expect(r.applied).toBe(1);
    expect(r.html).toContain('<a href="https://example.com"');
    expect(r.html).toContain('Click me');
    expect(r.html).toContain('rel="noopener noreferrer"');
  });

  it('wraps element matched by selector', () => {
    const html = '<div class="cta">Click me</div>';
    const r = applyLinks(html, [{ selector: '.cta', url: 'https://example.com' }]);
    expect(r.applied).toBe(1);
    expect(r.html).toContain('<a href="https://example.com"');
  });

  it('updates existing <a> instead of nesting', () => {
    const html = '<a data-otid="el1" href="old">x</a>';
    const r = applyLinks(html, [{ otid: 'el1', url: 'https://new.example.com' }]);
    expect(r.applied).toBe(1);
    expect(r.html).toContain('href="https://new.example.com"');
    expect(r.html).not.toContain('href="old"');
    expect(r.html.match(/<a\b/g)?.length).toBe(1);
  });

  it('adds title attribute when provided', () => {
    const html = '<div data-otid="el1">x</div>';
    const r = applyLinks(html, [
      { otid: 'el1', url: 'https://example.com', title: 'Visit example' }
    ]);
    expect(r.html).toContain('title="Visit example"');
  });

  it('skips link with unsafe url', () => {
    const html = '<div data-otid="el1">x</div>';
    const r = applyLinks(html, [{ otid: 'el1', url: 'javascript:alert(1)' }]);
    expect(r.applied).toBe(0);
    expect(r.skipped[0]?.reason).toBe('unsafe_url');
    expect(r.html).not.toContain('<a');
  });

  it('skips link with no matching target', () => {
    const html = '<div data-otid="el1">x</div>';
    const r = applyLinks(html, [{ otid: 'doesnotexist', url: 'https://example.com' }]);
    expect(r.applied).toBe(0);
    expect(r.skipped[0]?.reason).toBe('no_match');
  });

  it('preserves nested markup inside wrapped element', () => {
    const html = '<div data-otid="el1"><strong>Bold</strong> and <em>italic</em></div>';
    const r = applyLinks(html, [{ otid: 'el1', url: 'https://example.com' }]);
    expect(r.html).toContain('<strong>Bold</strong>');
    expect(r.html).toContain('<em>italic</em>');
  });

  it('applies multiple links to different targets', () => {
    const html = '<div data-otid="a">A</div><div data-otid="b">B</div>';
    const r = applyLinks(html, [
      { otid: 'a', url: 'https://a.example.com' },
      { otid: 'b', url: 'https://b.example.com' }
    ]);
    expect(r.applied).toBe(2);
    expect(r.html).toContain('href="https://a.example.com"');
    expect(r.html).toContain('href="https://b.example.com"');
  });

  it('does not crash on bad selector', () => {
    const html = '<div>x</div>';
    const r = applyLinks(html, [{ selector: 'invalid$$$', url: 'https://example.com' }]);
    // Either zero matches or skipped; just shouldn't throw.
    expect(r.applied).toBe(0);
  });
});
