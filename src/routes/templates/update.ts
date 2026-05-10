import type { FastifyPluginAsync } from 'fastify';
import type { TemplateStore } from '../../storage/fs.js';
import { updateSchema, type UpdateBody } from './_shared.js';

export const buildUpdateTemplateRoute =
  (store: TemplateStore): FastifyPluginAsync =>
  async (app) => {
    app.put<{ Params: { id: string }; Body: UpdateBody }>(
      '/templates/:id',
      {
        schema: {
          body: updateSchema,
          tags: ['templates'],
          summary: 'Update a template',
          description:
            'Partial update — only the fields present in the body are changed. ' +
            'Fields absent from the body keep their existing value. `id` and `createdAt` are immutable.'
        }
      },
      async (req, reply) => {
        const updated = await store.update(req.params.id, req.body);
        if (!updated) return reply.code(404).send({ error: 'not_found' });
        return updated;
      }
    );
  };
