import type { FastifyPluginAsync } from 'fastify';
import { renderPdf, type RenderInput } from '../../engines/render.js';
import { config } from '../../config.js';
import type { FilesStore } from '../../storage/files.js';
import {
  attachAssetHeaders,
  buildSingleStoreResponse,
  checkPixelArea,
  clampTimeout,
  renderBodySchema,
  shouldStore,
  storeQuerySchema,
  type AdHocBody,
  type StoreQuery
} from './_shared.js';

export const buildPdfRoute =
  (files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: AdHocBody; Querystring: StoreQuery }>(
      '/render/pdf',
      {
        schema: {
          body: renderBodySchema,
          querystring: storeQuerySchema,
          tags: ['render'],
          summary: 'Render PDF from inline HTML/CSS',
          description: [
            'Always uses Puppeteer — Satori produces SVG only. Output is a single page sized to ',
            '`{width, height}`. Returns `application/pdf` binary by default; `?store=true` returns JSON ',
            'with a `/files/{id}.pdf` URL.',
            '',
            '**Hyperlinks** in `data._links` produce clickable PDF link annotations on matching ',
            'elements (`data-otid` or selector).',
            '',
            'The `engine` field on the body is ignored — PDF is always Puppeteer.'
          ].join('\n')
        }
      },
      async (req, reply) => {
        const width = req.body.width ?? config.defaultWidth;
        const height = req.body.height ?? config.defaultHeight;
        const areaErr = checkPixelArea(width, height);
        if (areaErr) {
          return reply.code(400).send({ error: 'invalid_dimensions', message: areaErr });
        }
        const input: RenderInput = {
          html: req.body.html,
          css: req.body.css,
          data: req.body.data,
          width,
          height,
          timeoutMs: clampTimeout(req.body.timeoutMs)
        };
        try {
          const result = await renderPdf(input);
          if (shouldStore(req.query)) {
            return buildSingleStoreResponse(files, result, 'pdf', width, height);
          }
          reply.header('content-type', 'application/pdf');
          attachAssetHeaders(reply, result);
          return reply.send(result.buffer);
        } catch (err) {
          req.log.error({ err }, 'render_pdf_failed');
          return reply.code(500).send({
            error: 'render_failed',
            message: err instanceof Error ? err.message : 'unknown'
          });
        }
      }
    );
  };
