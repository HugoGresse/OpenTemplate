import * as cheerio from 'cheerio';
import type { AnyNode, Element as DomElement } from 'domhandler';

export interface TemplateLink {
  /** Match by data-otid attribute (preferred — design mode assigns these). */
  otid?: string;
  /** Or match by arbitrary CSS selector. */
  selector?: string;
  /** Destination URL — http(s) or mailto only. */
  url: string;
  /** Tooltip / accessible name. */
  title?: string;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Reject URL schemes that could yield script execution or local-file access
 * when rendered (javascript:, data:, file:, vbscript:, etc.). Returns the
 * original URL when safe, null otherwise.
 */
export function isSafeLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    // Allow relative URLs without a scheme (e.g. "/foo", "#bar") — they can't
    // execute script and the renderer ignores them in PNG anyway.
    return /^[#./?][^\s<>"]*$/.test(url) || /^[a-z0-9][a-z0-9._/?#=&%~+-]*$/i.test(url);
  }
}

interface ApplyLinksOptions {
  /** Skip this link instead of throwing if its selector finds nothing. */
  silent?: boolean;
}

export interface ApplyLinksResult {
  html: string;
  applied: number;
  skipped: Array<{ link: TemplateLink; reason: 'unsafe_url' | 'no_match' | 'no_target' }>;
}

/**
 * Wrap matched elements' children in <a href="..."> so the rendering engine
 * (Puppeteer) emits clickable PDF link annotations. Cheerio is used for
 * parse-correct rewriting; regex would break on nested same-tag elements.
 *
 * Targeting rule: each link must specify either `otid` or `selector` (not
 * both required). When both are present, `otid` wins. If the element is
 * already an <a>, its href is replaced rather than nested.
 */
export function applyLinks(
  html: string,
  links: TemplateLink[] | undefined,
  options: ApplyLinksOptions = {}
): ApplyLinksResult {
  if (!links || links.length === 0) {
    return { html, applied: 0, skipped: [] };
  }
  const $ = cheerio.load(html, { xml: false }, false); // fragment mode
  let applied = 0;
  const skipped: ApplyLinksResult['skipped'] = [];

  for (const link of links) {
    if (!isSafeLinkUrl(link.url)) {
      skipped.push({ link, reason: 'unsafe_url' });
      continue;
    }
    let target: cheerio.Cheerio<AnyNode> | null = null;
    if (link.otid) {
      target = $(`[data-otid="${cssEscape(link.otid)}"]`);
    } else if (link.selector) {
      try {
        target = $(link.selector);
      } catch {
        target = null;
      }
    }
    if (!target) {
      skipped.push({ link, reason: 'no_target' });
      continue;
    }
    if (target.length === 0) {
      skipped.push({ link, reason: 'no_match' });
      if (!options.silent) continue;
      continue;
    }

    target.each((_, el) => {
      const $el = $(el);
      const tag = el.type === 'tag' ? (el as DomElement).name : null;
      // Already an <a>? Just update href + title.
      if (tag === 'a') {
        $el.attr('href', link.url);
        if (link.title) $el.attr('title', link.title);
        applied++;
        return;
      }
      // Wrap inner content in an <a>. Preserves attributes and nested
      // markup. target=_blank + rel=noopener mirrors the editor's intent
      // for HTML preview; PDF doesn't care about target.
      const inner = $el.html();
      const $a = $('<a></a>')
        .attr('href', link.url)
        .attr('target', '_blank')
        .attr('rel', 'noopener noreferrer');
      if (link.title) $a.attr('title', link.title);
      $a.html(inner ?? '');
      $el.empty().append($a);
      applied++;
    });
  }

  return { html: $.html() ?? html, applied, skipped };
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
