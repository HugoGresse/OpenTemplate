import type { FastifyPluginAsync } from 'fastify';
import type { FilesStore } from '../../storage/files.js';
import { buildGetFileRoute } from './get.js';

export const buildFilesRoutes =
  (store: FilesStore): FastifyPluginAsync =>
  async (app) => {
    await app.register(buildGetFileRoute(store));
  };
