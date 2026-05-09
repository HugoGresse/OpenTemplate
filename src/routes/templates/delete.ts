import type { FastifyPluginAsync } from 'fastify';
import type { TemplateStore } from '../../storage/fs.js';

export const buildDeleteTemplateRoute =
  (store: TemplateStore): FastifyPluginAsync =>
  async (app) => {
    app.delete<{ Params: { id: string } }>(
      '/templates/:id',
      { schema: { tags: ['templates'], summary: 'Delete a template' } },
      async (req, reply) => {
        const ok = await store.delete(req.params.id);
        if (!ok) return reply.code(404).send({ error: 'not_found' });
        return { deleted: true };
      }
    );
  };
