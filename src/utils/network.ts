/**
 * Network safety helpers — block requests to private/loopback/link-local IPs
 * to prevent SSRF when Puppeteer is allowed to fetch external resources.
 */

const PRIVATE_V4_RANGES: Array<[number, number]> = [
  // 10.0.0.0/8
  [ipToInt(10, 0, 0, 0), ipToInt(10, 255, 255, 255)],
  // 172.16.0.0/12
  [ipToInt(172, 16, 0, 0), ipToInt(172, 31, 255, 255)],
  // 192.168.0.0/16
  [ipToInt(192, 168, 0, 0), ipToInt(192, 168, 255, 255)],
  // 127.0.0.0/8 loopback
  [ipToInt(127, 0, 0, 0), ipToInt(127, 255, 255, 255)],
  // 169.254.0.0/16 link-local + AWS metadata
  [ipToInt(169, 254, 0, 0), ipToInt(169, 254, 255, 255)],
  // 100.64.0.0/10 CGNAT
  [ipToInt(100, 64, 0, 0), ipToInt(100, 127, 255, 255)],
  // 0.0.0.0/8
  [ipToInt(0, 0, 0, 0), ipToInt(0, 255, 255, 255)]
];

function ipToInt(a: number, b: number, c: number, d: number): number {
  return ((a << 24) >>> 0) + ((b << 16) >>> 0) + ((c << 8) >>> 0) + d;
}

function parseV4(host: string): number | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map((s) => Number(s));
  if (parts.some((n) => n < 0 || n > 255)) return null;
  return ipToInt(parts[0]!, parts[1]!, parts[2]!, parts[3]!);
}

function isPrivateV4(host: string): boolean {
  const ip = parseV4(host);
  if (ip === null) return false;
  return PRIVATE_V4_RANGES.some(([lo, hi]) => ip >= lo && ip <= hi);
}

function isPrivateV6(host: string): boolean {
  if (!host.includes(':')) return false;
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '');
  // ::1 loopback, fe80::/10 link-local, fc00::/7 ULA, ::ffff:* mapped IPv4
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
    return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (isPrivateV4(v4)) return true;
  }
  return false;
}

export interface SafeUrlOptions {
  /** Hostnames the caller has explicitly opted into. */
  allowedHosts: readonly string[];
  /**
   * If true, ANY public host is allowed (private/loopback/metadata still
   * blocked by the IP-range checks). Use for trusted-network or dev contexts
   * where you don't want to maintain an allowlist.
   */
  allowPublic?: boolean;
}

/**
 * Decide if a URL is safe to fetch from inside this server.
 *
 * Always blocked:
 * - non-http(s) schemes
 * - private IPv4/IPv6 ranges, loopback, link-local, AWS metadata
 * - "localhost"
 *
 * Allowed:
 * - data: and about:
 * - public host explicitly listed in allowedHosts
 * - any public host when allowPublic is true
 */
export function isSafeUrl(url: string, options: SafeUrlOptions): boolean;
/** @deprecated Pass an options object. */
export function isSafeUrl(url: string, allowedHosts: readonly string[]): boolean;
export function isSafeUrl(
  url: string,
  optsOrHosts: SafeUrlOptions | readonly string[]
): boolean {
  const options: SafeUrlOptions = Array.isArray(optsOrHosts)
    ? { allowedHosts: optsOrHosts as readonly string[] }
    : (optsOrHosts as SafeUrlOptions);
  const { allowedHosts, allowPublic = false } = options;

  if (url.startsWith('data:') || url.startsWith('about:')) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname;
  if (!host) return false;

  if (isPrivateV4(host) || isPrivateV6(host)) return false;
  if (host === 'localhost') return false;

  if (allowedHosts.length === 0) return allowPublic;
  return allowedHosts.includes(host);
}
