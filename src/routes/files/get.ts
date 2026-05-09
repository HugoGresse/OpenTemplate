import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
import type { FilesStore } from '../../storage/files.js';

export const buildGetFileRoute =
  (store: FilesStore): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Params: { filename: string } }>(
      '/files/:filename',
      {
        schema: {
          tags: ['files'],
          summary: 'Fetch a stored render output (PNG or PDF) by filename'
        }
      },
      async (req, reply) => {
        const filename = req.params.filename;
        if (!store.isValidFilename(filename)) {
          return reply.code(400).send({ error: 'invalid_filename' });
        }
        const stat = await store.stat(filename);
        if (!stat) return reply.code(404).send({ error: 'not_found' });

        if (Date.now() - stat.mtimeMs > config.filesTtlSeconds * 1000) {
          return reply.code(410).send({ error: 'expired' });
        }

        const buf = await store.read(filename);
        if (!buf) return reply.code(404).send({ error: 'not_found' });

        const ext = filename.split('.').pop()?.toLowerCase();
        const ct = ext === 'pdf' ? 'application/pdf' : 'image/png';
        reply.header('content-type', ct);
        reply.header('content-length', String(buf.byteLength));
        reply.header('cache-control', 'public, max-age=3600');
        return reply.send(buf);
      }
    );
  };
