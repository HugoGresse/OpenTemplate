import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import type { TemplateStore } from '../storage/fs.js';

const createSchema = {
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

const updateSchema = {
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

const listQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    cursor: { type: 'string', maxLength: 64 }
  },
  additionalProperties: false
} as const;

interface CreateBody {
  name: string;
  html: string;
  css?: string;
  width?: number;
  height?: number;
  engine?: 'satori' | 'puppeteer' | 'auto';
  sampleData?: Record<string, unknown>;
}

type UpdateBody = Partial<CreateBody>;

interface ListQuery {
  limit?: number;
  cursor?: string;
}

export const buildTemplateRoutes =
  (store: TemplateStore): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: ListQuery }>(
      '/templates',
      { schema: { querystring: listQuerySchema } },
      async (req) => store.list({ limit: req.query.limit, cursor: req.query.cursor })
    );

    app.get<{ Params: { id: string } }>('/templates/:id', async (req, reply) => {
      const t = await store.get(req.params.id);
      if (!t) return reply.code(404).send({ error: 'not_found' });
      return t;
    });

    app.post<{ Body: CreateBody }>(
      '/templates',
      { schema: { body: createSchema } },
      async (req, reply) => {
        const t = await store.create({
          name: req.body.name,
          html: req.body.html,
          css: req.body.css,
          width: req.body.width,
          height: req.body.height,
          engine: req.body.engine ?? 'auto',
          sampleData: req.body.sampleData
        });
        return reply.code(201).send(t);
      }
    );

    app.put<{ Params: { id: string }; Body: UpdateBody }>(
      '/templates/:id',
      { schema: { body: updateSchema } },
      async (req, reply) => {
        const updated = await store.update(req.params.id, req.body);
        if (!updated) return reply.code(404).send({ error: 'not_found' });
        return updated;
      }
    );

    app.delete<{ Params: { id: string } }>('/templates/:id', async (req, reply) => {
      const ok = await store.delete(req.params.id);
      if (!ok) return reply.code(404).send({ error: 'not_found' });
      return { deleted: true };
    });
  };
