import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import type { FilesStore } from '../storage/files.js';

export const buildFilesRoutes =
  (store: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Params: { filename: string } }>(
      '/files/:filename',
      async (req, reply) => {
        const filename = req.params.filename;
        if (!store.isValidFilename(filename)) {
          return reply.code(400).send({ error: 'invalid_filename' });
        }
        const stat = await store.stat(filename);
        if (!stat) return reply.code(404).send({ error: 'not_found' });

        // TTL check via mtime — even though cleanup sweep runs hourly, refuse
        // to serve a file that's already past its window.
        if (Date.now() - stat.mtimeMs > config.filesTtlSeconds * 1000) {
          return reply.code(410).send({ error: 'expired' });
        }

        const buf = await store.read(filename);
        if (!buf) return reply.code(404).send({ error: 'not_found' });

        const ext = filename.split('.').pop()?.toLowerCase();
        const ct = ext === 'pdf' ? 'application/pdf' : 'image/png';
        reply.header('content-type', ct);
        reply.header('content-length', String(buf.byteLength));
        // Encourage caching since filenames carry enough entropy to be unique
        reply.header('cache-control', 'public, max-age=3600');
        return reply.send(buf);
      }
    );
  };
