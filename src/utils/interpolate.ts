import Mustache from 'mustache';

// HTML-escape map identical to Mustache 4.x defaults — see node_modules/mustache/mustache.js.
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;'
};

/**
 * Escape HTML AND convert newlines to <br>. Applied to every `{{var}}`
 * substitution. Use `{{{var}}}` for raw output (no escape, no nl2br).
 */
function escapeWithNl2br(value: unknown): string {
  const text = String(value ?? '');
  const escaped = text.replace(/[&<>"'`=/]/g, (c) => ESCAPE_MAP[c] ?? c);
  return escaped.replace(/\r\n|\r|\n/g, '<br />');
}

// Mustache exposes a global `escape` hook. Override once at module load.
// Safe in this codebase — Mustache is used only by interpolate().
(Mustache as unknown as { escape: (s: unknown) => string }).escape = escapeWithNl2br;

/**
 * Render a Mustache template against a data object.
 *
 * - {{var}}   → HTML-escaped, newlines become <br />
 * - {{{var}}} → raw value, no escaping (use when value already contains HTML)
 *
 * Missing keys render as empty strings (Mustache default).
 */
export function interpolate(template: string, data: Record<string, unknown> = {}): string {
  return Mustache.render(template, data);
}
