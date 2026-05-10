import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
import type { FilesStore } from '../../storage/files.js';
import {
  checkPixelArea,
  clampTimeout,
  dispatchRender,
  parseOutput,
  parseStore,
  renderBodySchema,
  renderQuerySchema,
  sendRender,
  type AdHocBody,
  type RenderQuery
} from './_shared.js';

export const buildPdfRoute =
  (files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: AdHocBody; Querystring: RenderQuery }>(
      '/render/pdf',
      {
        schema: {
          body: renderBodySchema,
          querystring: renderQuerySchema,
          tags: ['render'],
          summary: 'Render PDF from inline HTML/CSS',
          description: [
            'Default output: PDF (binary `application/pdf`). Same `?output=` and `?store=` semantics ',
            'as `/render/png`. PDF rendering always uses Puppeteer; the body `engine` field is honored ',
            'only for the PNG side when `?output=png+pdf`.'
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
        const output = parseOutput(req.query.output, { png: false, pdf: true });
        const store = parseStore(req.query.store);
        try {
          const result = await dispatchRender({
            input: {
              html: req.body.html,
              css: req.body.css,
              data: req.body.data,
              width,
              height,
              engine: req.body.engine ?? 'auto',
              timeoutMs: clampTimeout(req.body.timeoutMs)
            },
            output,
            store,
            files,
            width,
            height
          });
          return sendRender(reply, result);
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
