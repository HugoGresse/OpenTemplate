import type { FastifyPluginAsync } from 'fastify';
import { renderPng } from '../../engines/render.js';
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

export const buildStoredPngRoute =
  (templates: TemplateStore, files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Params: { id: string }; Body: StoredBody; Querystring: StoreQuery }>(
      '/render/:id/png',
      {
        schema: {
          body: storedRenderBodySchema,
          querystring: storeQuerySchema,
          tags: ['render'],
          summary: 'Render a stored template as PNG',
          description: [
            'Renders the template identified by `:id` (created via `POST /templates`). ',
            'Engine + dimensions come from the template; only `data` and `timeoutMs` may be sent in the body.',
            '',
            '**Data resolution:** body `data` overrides; if omitted, the template\'s `sampleData` is used. ',
            'Send `data: {_links: {...}}` to attach links per-call without modifying the stored template.',
            '',
            '`?store=true` behaves the same as the inline endpoint — JSON URL response instead of binary.'
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
          const result = await renderPng({
            html: tpl.html,
            css: tpl.css,
            data: req.body?.data ?? tpl.sampleData,
            width,
            height,
            engine: tpl.engine ?? 'auto',
            timeoutMs: clampTimeout(req.body?.timeoutMs)
          });
          if (shouldStore(req.query)) {
            return buildSingleStoreResponse(files, result, 'png', width, height);
          }
          reply.header('content-type', 'image/png');
          attachAssetHeaders(reply, result);
          return reply.send(result.buffer);
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
