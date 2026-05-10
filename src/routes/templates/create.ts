import type { FastifyPluginAsync } from 'fastify';
import type { TemplateStore } from '../../storage/fs.js';
import { createSchema, type CreateBody } from './_shared.js';

export const buildCreateTemplateRoute =
  (store: TemplateStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: CreateBody }>(
      '/templates',
      {
        schema: {
          body: createSchema,
          tags: ['templates'],
          summary: 'Create a template',
          description:
            'Returns 201 with the created Template (server-assigned `id`, ISO timestamps). ' +
            'IDs are 10-char nanoid (URL-safe). Render later via `POST /render/{id}/{format}`.'
        }
      },
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
  };
