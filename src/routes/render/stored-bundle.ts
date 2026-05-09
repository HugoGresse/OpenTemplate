import type { FastifyPluginAsync } from 'fastify';
import { renderPdf, renderPng, type RenderInput } from '../../engines/render.js';
import { config } from '../../config.js';
import type { TemplateStore } from '../../storage/fs.js';
import type { FilesStore } from '../../storage/files.js';
import {
  bundleResponse,
  checkPixelArea,
  shouldStore,
  storeQuerySchema,
  storedRenderBodySchema,
  type StoreQuery,
  type StoredBody
} from './_shared.js';

export const buildStoredBundleRoute =
  (templates: TemplateStore, files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Params: { id: string }; Body: StoredBody; Querystring: StoreQuery }>(
      '/render/:id/bundle',
      {
        schema: {
          body: storedRenderBodySchema,
          querystring: storeQuerySchema,
          tags: ['render'],
          summary: 'Render a stored template as PNG + PDF in one round-trip'
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
        const input: RenderInput = {
          html: tpl.html,
          css: tpl.css,
          data: req.body?.data ?? tpl.sampleData,
          width,
          height,
          engine: tpl.engine ?? 'auto'
        };
        try {
          const [png, pdf] = await Promise.all([renderPng(input), renderPdf(input)]);
          return bundleResponse(files, png, pdf, width, height, shouldStore(req.query));
        } catch (err) {
          req.log.error({ err, templateId: req.params.id }, 'render_stored_bundle_failed');
          return reply.code(500).send({
            error: 'render_failed',
            message: err instanceof Error ? err.message : 'unknown'
          });
        }
      }
    );
  };
