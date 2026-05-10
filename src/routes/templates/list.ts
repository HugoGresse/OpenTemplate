import type { FastifyPluginAsync } from 'fastify';
import type { TemplateStore } from '../../storage/fs.js';
import { listQuerySchema, type ListQuery } from './_shared.js';

export const buildListTemplatesRoute =
  (store: TemplateStore): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: ListQuery }>(
      '/templates',
      {
        schema: {
          querystring: listQuerySchema,
          tags: ['templates'],
          summary: 'List templates (paginated)',
          description:
            'Returns `{items: Template[], nextCursor: string|null}`. Items sorted by `updatedAt` ' +
            'descending. Pass `cursor` from the previous response to fetch the next page; `nextCursor: null` ' +
            'means the last page.'
        }
      },
      async (req) => store.list({ limit: req.query.limit, cursor: req.query.cursor })
    );
  };
