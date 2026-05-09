import type { FastifyPluginAsync } from 'fastify';
import type { TemplateStore } from '../../storage/fs.js';

export const buildGetTemplateRoute =
  (store: TemplateStore): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Params: { id: string } }>(
      '/templates/:id',
      { schema: { tags: ['templates'], summary: 'Get one template by id' } },
      async (req, reply) => {
        const t = await store.get(req.params.id);
        if (!t) return reply.code(404).send({ error: 'not_found' });
        return t;
      }
    );
  };
