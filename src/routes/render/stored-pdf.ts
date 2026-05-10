import type { FastifyPluginAsync } from 'fastify';
import { renderPdf } from '../../engines/render.js';
import { config } from '../../config.js';
import type { TemplateStore } from '../../storage/fs.js';
import type { FilesStore } from '../../storage/files.js';
import {
  attachAssetHeaders,
  buildSingleStoreResponse,
  checkPixelArea,
  clampTimeout,
  shouldStore,
  storeQuerySchema,
  storedRenderBodySchema,
  type StoreQuery,
  type StoredBody
} from './_shared.js';

export const buildStoredPdfRoute =
  (templates: TemplateStore, files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Params: { id: string }; Body: StoredBody; Querystring: StoreQuery }>(
      '/render/:id/pdf',
      {
        schema: {
          body: storedRenderBodySchema,
          querystring: storeQuerySchema,
          tags: ['render'],
          summary: 'Render a stored template as PDF',
          description: [
            'Same data-resolution rules as `/render/{id}/png`. Always uses Puppeteer. ',
            '`data._links` produces clickable annotations.'
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
        try {
          const result = await renderPdf({
            html: tpl.html,
            css: tpl.css,
            data: req.body?.data ?? tpl.sampleData,
            width,
            height,
            timeoutMs: clampTimeout(req.body?.timeoutMs)
          });
          if (shouldStore(req.query)) {
            return buildSingleStoreResponse(files, result, 'pdf', width, height);
          }
          reply.header('content-type', 'application/pdf');
          attachAssetHeaders(reply, result);
          return reply.send(result.buffer);
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
