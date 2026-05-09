import type { FastifyPluginAsync } from 'fastify';
import type { TemplateStore } from '../../storage/fs.js';
import type { FilesStore } from '../../storage/files.js';
import { buildPngRoute } from './png.js';
import { buildPdfRoute } from './pdf.js';
import { buildBundleRoute } from './bundle.js';
import { buildStoredPngRoute } from './stored-png.js';
import { buildStoredPdfRoute } from './stored-pdf.js';
import { buildStoredBundleRoute } from './stored-bundle.js';

/**
 * Composer for all /render/* endpoints. Each route lives in its own file —
 * see siblings of this index. Group is registered under a single instance
 * by server.ts so the stricter render rate limit applies uniformly.
 */
export const buildRenderRoutes =
  (templates: TemplateStore, files: FilesStore): FastifyPluginAsync =>
  async (app) => {
    await app.register(buildPngRoute(files));
    await app.register(buildPdfRoute(files));
    await app.register(buildBundleRoute(files));
    await app.register(buildStoredPngRoute(templates, files));
    await app.register(buildStoredPdfRoute(templates, files));
    await app.register(buildStoredBundleRoute(templates, files));
  };
