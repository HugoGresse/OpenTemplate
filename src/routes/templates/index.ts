import type { FastifyPluginAsync } from 'fastify';
import type { TemplateStore } from '../../storage/fs.js';
import { buildListTemplatesRoute } from './list.js';
import { buildGetTemplateRoute } from './get.js';
import { buildCreateTemplateRoute } from './create.js';
import { buildUpdateTemplateRoute } from './update.js';
import { buildDeleteTemplateRoute } from './delete.js';

export const buildTemplateRoutes =
  (store: TemplateStore): FastifyPluginAsync =>
  async (app) => {
    await app.register(buildListTemplatesRoute(store));
    await app.register(buildGetTemplateRoute(store));
    await app.register(buildCreateTemplateRoute(store));
    await app.register(buildUpdateTemplateRoute(store));
    await app.register(buildDeleteTemplateRoute(store));
  };
