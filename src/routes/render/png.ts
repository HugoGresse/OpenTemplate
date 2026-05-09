import type { FastifyPluginAsync } from 'fastify';
import { renderPng, type RenderInput } from '../../engines/render.js';
import { config } from '../../config.js';
import type { FilesStore } from '../../storage/files.js';
import {
  attachAssetHeaders,
  buildSingleStoreResponse,
  checkPixelArea,
  renderBodySchema,
  shouldStore,
  storeQuerySchema,
  type AdHocBody,
  type StoreQuery
} from './_shared.js';

export const buildPngRoute =
  (files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: AdHocBody; Querystring: StoreQuery }>(
      '/render/png',
      {
        schema: {
          body: renderBodySchema,
          querystring: storeQuerySchema,
          tags: ['render'],
          summary: 'Render PNG from inline HTML/CSS'
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
          engine: req.body.engine ?? 'auto'
        };
        try {
          const result = await renderPng(input);
          if (shouldStore(req.query)) {
            return buildSingleStoreResponse(files, result, 'png', width, height);
          }
          reply.header('content-type', 'image/png');
          attachAssetHeaders(reply, result);
          return reply.send(result.buffer);
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
