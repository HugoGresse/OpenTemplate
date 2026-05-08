import { describe, it, expect } from 'vitest';
import { isSafeUrl } from '../../src/utils/network.js';

describe('isSafeUrl', () => {
  it('allows data: URIs', () => {
    expect(isSafeUrl('data:image/png;base64,AAAA', [])).toBe(true);
  });

  it('allows about: URIs', () => {
    expect(isSafeUrl('about:blank', [])).toBe(true);
  });

  it('blocks loopback IPv4', () => {
    expect(isSafeUrl('http://127.0.0.1/x', ['127.0.0.1'])).toBe(false);
  });

  it('blocks AWS metadata service', () => {
    expect(isSafeUrl('http://169.254.169.254/latest/meta-data/', [])).toBe(false);
  });

  it('blocks private RFC1918 ranges', () => {
    expect(isSafeUrl('http://10.0.0.1/', ['10.0.0.1'])).toBe(false);
    expect(isSafeUrl('http://192.168.1.1/', ['192.168.1.1'])).toBe(false);
    expect(isSafeUrl('http://172.16.0.1/', ['172.16.0.1'])).toBe(false);
  });

  it('blocks IPv6 loopback', () => {
    expect(isSafeUrl('http://[::1]/', [])).toBe(false);
  });

  it('blocks localhost hostname', () => {
    expect(isSafeUrl('http://localhost/', ['localhost'])).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    expect(isSafeUrl('file:///etc/passwd', [])).toBe(false);
    expect(isSafeUrl('javascript:alert(1)', [])).toBe(false);
    expect(isSafeUrl('ftp://example.com/', [])).toBe(false);
  });

  it('blocks public hosts when allowedHosts is empty (strict-by-default)', () => {
    expect(isSafeUrl('https://example.com/', [])).toBe(false);
  });

  it('allows public hosts only when in allowlist', () => {
    expect(isSafeUrl('https://example.com/x', ['example.com'])).toBe(true);
    expect(isSafeUrl('https://other.com/x', ['example.com'])).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isSafeUrl('not a url', [])).toBe(false);
    expect(isSafeUrl('', [])).toBe(false);
  });

  describe('allowPublic option', () => {
    it('allows any public host when allowPublic=true', () => {
      expect(isSafeUrl('https://example.com/x', { allowedHosts: [], allowPublic: true })).toBe(true);
      expect(isSafeUrl('https://www.google.com/', { allowedHosts: [], allowPublic: true })).toBe(true);
    });

    it('still blocks private/loopback/metadata even with allowPublic=true', () => {
      expect(isSafeUrl('http://10.0.0.5/', { allowedHosts: [], allowPublic: true })).toBe(false);
      expect(isSafeUrl('http://127.0.0.1/', { allowedHosts: [], allowPublic: true })).toBe(false);
      expect(isSafeUrl('http://169.254.169.254/', { allowedHosts: [], allowPublic: true })).toBe(false);
      expect(isSafeUrl('http://localhost/', { allowedHosts: [], allowPublic: true })).toBe(false);
      expect(isSafeUrl('http://[::1]/', { allowedHosts: [], allowPublic: true })).toBe(false);
    });

    it('still rejects non-http(s) schemes with allowPublic=true', () => {
      expect(isSafeUrl('file:///etc/passwd', { allowedHosts: [], allowPublic: true })).toBe(false);
      expect(isSafeUrl('javascript:alert(1)', { allowedHosts: [], allowPublic: true })).toBe(false);
    });

    it('allowedHosts narrows further when both options set', () => {
      expect(isSafeUrl('https://a.com/', { allowedHosts: ['a.com'], allowPublic: true })).toBe(true);
      expect(isSafeUrl('https://b.com/', { allowedHosts: ['a.com'], allowPublic: true })).toBe(false);
    });

    it('options form accepts old positional allowedHosts call', () => {
      expect(isSafeUrl('https://example.com/', ['example.com'])).toBe(true);
      expect(isSafeUrl('https://example.com/', [])).toBe(false);
    });
  });
});
