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

export const buildPngRoute =
  (files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: AdHocBody; Querystring: RenderQuery }>(
      '/render/png',
      {
        schema: {
          body: renderBodySchema,
          querystring: renderQuerySchema,
          tags: ['render'],
          summary: 'Render PNG from inline HTML/CSS',
          description: [
            'Default output: PNG (binary `image/png`).',
            '',
            '**Override output formats** with `?output=png`, `?output=pdf`, or ',
            '`?output=png+pdf` (multi-format JSON response).',
            '',
            '**Response modes** via `?store`:',
            '- omitted → binary (single format) or base64 bundle (multi-format)',
            '- `url` → JSON with stored file URL(s) at `/files/{id}.{ext}`',
            '- `data` → JSON with base64 payload(s)',
            '- `url+data` → JSON with both',
            '',
            'Tokens combine with `+`, `,`, or whitespace.'
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
        const output = parseOutput(req.query.output, { png: true, pdf: false });
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
          req.log.error({ err }, 'render_png_failed');
          return reply.code(500).send({
            error: 'render_failed',
            message: err instanceof Error ? err.message : 'unknown'
          });
        }
      }
    );
  };
