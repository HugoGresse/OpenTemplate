import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
import type { TemplateStore } from '../../storage/fs.js';
import type { FilesStore } from '../../storage/files.js';
import {
  checkPixelArea,
  clampTimeout,
  dispatchRender,
  parseOutput,
  parseStore,
  renderQuerySchema,
  sendRender,
  storedRenderBodySchema,
  type RenderQuery,
  type StoredBody
} from './_shared.js';

export const buildStoredPngRoute =
  (templates: TemplateStore, files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Params: { id: string }; Body: StoredBody; Querystring: RenderQuery }>(
      '/render/:id/png',
      {
        schema: {
          body: storedRenderBodySchema,
          querystring: renderQuerySchema,
          tags: ['render'],
          summary: 'Render a stored template as PNG',
          description: [
            'Renders the template identified by `:id`. Engine + dimensions come from the stored ',
            'template; only `data` and `timeoutMs` may be sent in the body.',
            '',
            '**Data resolution:** body `data` overrides; if omitted, the template\'s `sampleData` is used.',
            '',
            'Same `?output=` and `?store=` semantics as `/render/png`.'
          ].join('\n')
        }
      },
      async (req, reply) => {
        const tpl = await templates.get(req.params.id);
        if (!tpl) return reply.code(404).send({ error: 'template_not_found' });
        const width = tpl.width ?? config.defaultWidth;
        const height = tpl.height ?? config.defaultHeight;
        const areaErr = checkPixelArea(width, height);
        if (areaErr) {
          return reply.code(400).send({ error: 'invalid_dimensions', message: areaErr });
        }
        const output = parseOutput(req.query.output, { png: true, pdf: false });
        const store = parseStore(req.query.store);
        try {
          const result = await dispatchRender({
            input: {
              html: tpl.html,
              css: tpl.css,
              data: req.body?.data ?? tpl.sampleData,
              width,
              height,
              engine: tpl.engine ?? 'auto',
              timeoutMs: clampTimeout(req.body?.timeoutMs)
            },
            output,
            store,
            files,
            width,
            height
          });
          return sendRender(reply, result);
        } catch (err) {
          req.log.error({ err, templateId: req.params.id }, 'render_stored_png_failed');
          return reply.code(500).send({
            error: 'render_failed',
            message: err instanceof Error ? err.message : 'unknown'
          });
        }
      }
    );
  };
