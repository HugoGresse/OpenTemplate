import { config } from '../../config.js';

export const createSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: config.maxNameLen },
    html: { type: 'string', minLength: 1, maxLength: 200_000 },
    css: { type: 'string', maxLength: 200_000 },
    width: { type: 'number', minimum: 1, maximum: config.maxDimension },
    height: { type: 'number', minimum: 1, maximum: config.maxDimension },
    engine: { type: 'string', enum: ['satori', 'puppeteer', 'auto'] },
    sampleData: { type: 'object', additionalProperties: true }
  },
  required: ['name', 'html'],
  additionalProperties: false
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
    sampleData: { type: 'object', additionalProperties: true }
  },
  additionalProperties: false
} as const;

export const listQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    cursor: { type: 'string', maxLength: 64 }
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
