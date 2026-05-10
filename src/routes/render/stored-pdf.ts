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

export const buildStoredPdfRoute =
  (templates: TemplateStore, files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Params: { id: string }; Body: StoredBody; Querystring: RenderQuery }>(
      '/render/:id/pdf',
      {
        schema: {
          body: storedRenderBodySchema,
          querystring: renderQuerySchema,
          tags: ['render'],
          summary: 'Render a stored template as PDF',
          description:
            'Same data-resolution rules as `/render/{id}/png`. PDF always uses Puppeteer. ' +
            '`data._links` produces clickable annotations. ' +
            'Same `?output=` and `?store=` semantics as `/render/pdf`.'
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
        const output = parseOutput(req.query.output, { png: false, pdf: true });
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
          req.log.error({ err, templateId: req.params.id }, 'render_stored_pdf_failed');
          return reply.code(500).send({
            error: 'render_failed',
            message: err instanceof Error ? err.message : 'unknown'
          });
        }
      }
    );
  };
