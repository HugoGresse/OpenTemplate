import { config } from '../../config.js';

// Hyperlinks live inside `sampleData._links` — see engines/render.ts
// extractLinksFromData. No separate `links` field on the template.

const sampleDataDescription =
  'Default Mustache data for /render/{id}/* when the caller omits `data`. ' +
  'Reserved key `_links` configures hyperlinks (see top of doc).';

export const createSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: config.maxNameLen, description: 'Human label.' },
    html: {
      type: 'string',
      minLength: 1,
      maxLength: 200_000,
      description: 'HTML body with optional `{{var}}` Mustache placeholders and `data-otid` markers.'
    },
    css: { type: 'string', maxLength: 200_000 },
    width: {
      type: 'number',
      minimum: 1,
      maximum: config.maxDimension,
      description: 'Default render width in px.'
    },
    height: {
      type: 'number',
      minimum: 1,
      maximum: config.maxDimension,
      description: 'Default render height in px.'
    },
    engine: {
      type: 'string',
      enum: ['satori', 'puppeteer', 'auto'],
      description: 'Default engine; can be overridden per render call.'
    },
    sampleData: { type: 'object', additionalProperties: true, description: sampleDataDescription }
  },
  required: ['name', 'html'],
  additionalProperties: false,
  examples: [
    {
      summary: 'Card with link',
      value: {
        name: 'social-share',
        html: '<div data-otid="cta" style="display:flex;width:1200px;height:630px;background:#000;color:#fff;align-items:center;justify-content:center;font-size:64px;">{{title}}</div>',
        width: 1200,
        height: 630,
        engine: 'auto',
        sampleData: {
          title: 'Default headline',
          _links: { cta: 'https://example.com' }
        }
      }
    }
  ]
} as const;

export const updateSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: config.maxNameLen },
    html: { type: 'string', minLength: 1, maxLength: 200_000 },
    css: { type: 'string', maxLength: 200_000 },
    width: { type: 'number', minimum: 1, maximum: config.maxDimension },
    height: { type: 'number', minimum: 1, maximum: config.maxDimension },
    engine: { type: 'string', enum: ['satori', 'puppeteer', 'auto'] },
    sampleData: { type: 'object', additionalProperties: true, description: sampleDataDescription }
  },
  additionalProperties: false,
  description:
    'Partial update — fields omitted are preserved. PUT with `sampleData: {}` clears it; ' +
    'omit the key entirely to keep the existing value.'
} as const;

export const listQuerySchema = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: 'Page size. Default 100, max 500.'
    },
    cursor: {
      type: 'string',
      maxLength: 64,
      description:
        'Opaque cursor from a prior response\'s `nextCursor` field. Templates returned in updatedAt-desc order.'
    }
  },
  additionalProperties: false
} as const;

export interface CreateBody {
  name: string;
  html: string;
  css?: string;
  width?: number;
  height?: number;
  engine?: 'satori' | 'puppeteer' | 'auto';
  sampleData?: Record<string, unknown>;
}

export type UpdateBody = Partial<CreateBody>;

export interface ListQuery {
  limit?: number;
  cursor?: string;
}
