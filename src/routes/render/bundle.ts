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

export const buildBundleRoute =
  (files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: AdHocBody; Querystring: RenderQuery }>(
      '/render/bundle',
      {
        schema: {
          body: renderBodySchema,
          querystring: renderQuerySchema,
          tags: ['render'],
          summary: 'Render PNG + PDF in a single round-trip',
          description: [
            'Default output: PNG + PDF (multi-format JSON). Wall-clock time = max(PNG, PDF), not sum.',
            '',
            'Response shape varies with `?store`:',
            '- omitted → `{ png: {data: <base64>}, pdf: {data: <base64>}, engineUsed: {png, pdf}, ... }` (legacy)',
            '- `url` → `{ png: {id, url, size}, pdf: {id, url, size}, expiresAt, ... }`',
            '- `data` → same as omitted',
            '- `url+data` → both `{id, url, size, data}` per format',
            '',
            'Set `?output=png` or `?output=pdf` to render only one format on this endpoint.',
            '',
            'Counts as one request against the rate-limit bucket regardless of format count.'
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
        const output = parseOutput(req.query.output, { png: true, pdf: true });
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
          req.log.error({ err }, 'render_bundle_failed');
          return reply.code(500).send({
            error: 'render_failed',
            message: err instanceof Error ? err.message : 'unknown'
          });
        }
      }
    );
  };
