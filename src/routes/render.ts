import type { FastifyPluginAsync } from 'fastify';
import { renderPng, renderPdf, type RenderInput, type RenderResult } from '../engines/render.js';
import { config } from '../config.js';
import type { TemplateStore } from '../storage/fs.js';
import type { FilesStore } from '../storage/files.js';

const renderBodySchema = {
  type: 'object',
  properties: {
    html: { type: 'string', minLength: 1, maxLength: 200_000 },
    css: { type: 'string', maxLength: 200_000 },
    data: { type: 'object', additionalProperties: true },
    width: { type: 'number', minimum: 1, maximum: config.maxDimension },
    height: { type: 'number', minimum: 1, maximum: config.maxDimension },
    engine: { type: 'string', enum: ['satori', 'puppeteer', 'auto'] }
  },
  required: ['html'],
  additionalProperties: false
} as const;

const storedRenderBodySchema = {
  type: 'object',
  properties: {
    data: { type: 'object', additionalProperties: true }
  },
  additionalProperties: false
} as const;

const storeQuerySchema = {
  type: 'object',
  properties: {
    store: { type: 'string', enum: ['true', 'false', '1', '0'] }
  },
  additionalProperties: false
} as const;

interface AdHocBody {
  html: string;
  css?: string;
  data?: Record<string, unknown>;
  width?: number;
  height?: number;
  engine?: 'satori' | 'puppeteer' | 'auto';
}

interface StoredBody {
  data?: Record<string, unknown>;
}

interface StoreQuery {
  store?: string;
}

function shouldStore(query: StoreQuery | undefined): boolean {
  const v = query?.store;
  return v === 'true' || v === '1';
}

function checkPixelArea(width: number, height: number): string | null {
  if (width * height > config.maxPixelArea) {
    return `pixel_area_exceeded:${width * height}_max:${config.maxPixelArea}`;
  }
  return null;
}

function fallbackHeader(reason: string): string {
  return encodeURIComponent(reason.slice(0, 200));
}

function attachAssetHeaders(reply: { header: (k: string, v: string) => unknown }, result: RenderResult): void {
  reply.header('x-engine', result.engineUsed);
  reply.header('x-assets-inlined', String(result.assetsInlined));
  if (result.assetsSkipped > 0) {
    reply.header('x-assets-skipped', String(result.assetsSkipped));
    reply.header(
      'x-assets-skip-detail',
      fallbackHeader(result.assetsSkipDetails.map((d) => `${d.reason}:${d.url}`).join('|'))
    );
  }
  if (result.fallbackReason) {
    reply.header('x-fallback-reason', fallbackHeader(result.fallbackReason));
  }
}

interface SingleStoreResponse {
  id: string;
  url: string;
  format: 'png' | 'pdf';
  engineUsed: 'satori' | 'puppeteer';
  width: number;
  height: number;
  size: number;
  expiresAt: string;
  assetsInlined: number;
  assetsSkipped: number;
  fallbackReason: string | null;
}

async function buildSingleStoreResponse(
  files: FilesStore,
  result: RenderResult,
  ext: 'png' | 'pdf',
  width: number,
  height: number
): Promise<SingleStoreResponse> {
  const stored = await files.save(result.buffer, ext, config.filesTtlSeconds);
  return {
    id: stored.id,
    url: stored.url,
    format: ext,
    engineUsed: result.engineUsed,
    width,
    height,
    size: stored.size,
    expiresAt: stored.expiresAt.toISOString(),
    assetsInlined: result.assetsInlined,
    assetsSkipped: result.assetsSkipped,
    fallbackReason: result.fallbackReason ?? null
  };
}

export const buildRenderRoutes =
  (templates: TemplateStore, files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    const sharedSchema = { querystring: storeQuerySchema };

    // ----- /render/png -----

    app.post<{ Body: AdHocBody; Querystring: StoreQuery }>(
      '/render/png',
      { schema: { body: renderBodySchema, ...sharedSchema } },
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

    // ----- /render/pdf -----

    app.post<{ Body: AdHocBody; Querystring: StoreQuery }>(
      '/render/pdf',
      { schema: { body: renderBodySchema, ...sharedSchema } },
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
          height
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

    // ----- /render/:id/png -----

    app.post<{ Params: { id: string }; Body: StoredBody; Querystring: StoreQuery }>(
      '/render/:id/png',
      { schema: { body: storedRenderBodySchema, ...sharedSchema } },
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
            engine: tpl.engine ?? 'auto'
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

    // ----- /render/:id/pdf -----

    app.post<{ Params: { id: string }; Body: StoredBody; Querystring: StoreQuery }>(
      '/render/:id/pdf',
      { schema: { body: storedRenderBodySchema, ...sharedSchema } },
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
            height
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

    // ----- /render/bundle -----

    async function bundleResponse(
      png: RenderResult,
      pdf: RenderResult,
      width: number,
      height: number,
      store: boolean
    ) {
      if (store) {
        const [pngFile, pdfFile] = await Promise.all([
          files.save(png.buffer, 'png', config.filesTtlSeconds),
          files.save(pdf.buffer, 'pdf', config.filesTtlSeconds)
        ]);
        return {
          png: { id: pngFile.id, url: pngFile.url, size: pngFile.size },
          pdf: { id: pdfFile.id, url: pdfFile.url, size: pdfFile.size },
          engineUsed: { png: png.engineUsed, pdf: pdf.engineUsed },
          fallbackReason: png.fallbackReason ?? null,
          assetsInlined: png.assetsInlined,
          assetsSkipped: png.assetsSkipped,
          expiresAt: pngFile.expiresAt.toISOString(),
          width,
          height
        };
      }
      return {
        png: png.buffer.toString('base64'),
        pdf: pdf.buffer.toString('base64'),
        engineUsed: { png: png.engineUsed, pdf: pdf.engineUsed },
        fallbackReason: png.fallbackReason ?? null,
        assetsInlined: png.assetsInlined,
        assetsSkipped: png.assetsSkipped,
        width,
        height
      };
    }

    app.post<{ Body: AdHocBody; Querystring: StoreQuery }>(
      '/render/bundle',
      { schema: { body: renderBodySchema, ...sharedSchema } },
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
          const [png, pdf] = await Promise.all([renderPng(input), renderPdf(input)]);
          return bundleResponse(png, pdf, width, height, shouldStore(req.query));
        } catch (err) {
          req.log.error({ err }, 'render_bundle_failed');
          return reply.code(500).send({
            error: 'render_failed',
            message: err instanceof Error ? err.message : 'unknown'
          });
        }
      }
    );

    app.post<{ Params: { id: string }; Body: StoredBody; Querystring: StoreQuery }>(
      '/render/:id/bundle',
      { schema: { body: storedRenderBodySchema, ...sharedSchema } },
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
          return bundleResponse(png, pdf, width, height, shouldStore(req.query));
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
