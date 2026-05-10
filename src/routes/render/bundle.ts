import type { FastifyPluginAsync } from 'fastify';
import { renderPdf, renderPng, type RenderInput } from '../../engines/render.js';
import { config } from '../../config.js';
import type { FilesStore } from '../../storage/files.js';
import {
  bundleResponse,
  checkPixelArea,
  clampTimeout,
  renderBodySchema,
  shouldStore,
  storeQuerySchema,
  type AdHocBody,
  type StoreQuery
} from './_shared.js';

export const buildBundleRoute =
  (files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: AdHocBody; Querystring: StoreQuery }>(
      '/render/bundle',
      {
        schema: {
          body: renderBodySchema,
          querystring: storeQuerySchema,
          tags: ['render'],
          summary: 'Render PNG + PDF in a single round-trip',
          description: [
            'Renders both formats in parallel. Wall-clock time = max(PNG, PDF), not sum.',
            '',
            'Default response: JSON `{png: <base64>, pdf: <base64>, engineUsed: {png, pdf}, ...}`.',
            'With `?store=true`: JSON `{png: {id, url, size}, pdf: {id, url, size}, engineUsed, expiresAt, ...}`.',
            '',
            'Counts as **one** request against the rate-limit bucket — efficient when callers need both.'
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
          engine: req.body.engine ?? 'auto',
          timeoutMs: clampTimeout(req.body.timeoutMs)
        };
        try {
          const [png, pdf] = await Promise.all([renderPng(input), renderPdf(input)]);
          return bundleResponse(files, png, pdf, width, height, shouldStore(req.query));
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
