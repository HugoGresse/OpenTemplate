import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';

export type StoredExt = 'png' | 'pdf';

export interface StoredFile {
  id: string;
  filename: string;
  url: string;
  size: number;
  expiresAt: Date;
}

const FILENAME_RE = /^[A-Za-z0-9_-]+\.(png|pdf)$/;

/**
 * Filesystem-backed store for rendered outputs (PNG / PDF). One file per id,
 * served publicly via GET /files/:filename. TTL enforced by background sweep
 * over mtime — periodic call to cleanupOlderThan().
 *
 * Atomic writes: temp file + rename. Filename validation prevents path
 * traversal.
 */
export class FilesStore {
  constructor(
    private readonly dir: string,
    private readonly publicPrefix: string,
    private readonly publicBaseUrl?: string
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  isValidFilename(filename: string): boolean {
    return FILENAME_RE.test(filename);
  }

  private resolve(filename: string): string {
    if (!FILENAME_RE.test(filename)) throw new Error('invalid_filename');
    return path.join(this.dir, filename);
  }

  private buildUrl(filename: string): string {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${filename}`;
    }
    return `${this.publicPrefix}/${filename}`;
  }

  async save(buffer: Buffer, ext: StoredExt, ttlSeconds: number): Promise<StoredFile> {
    const id = nanoid(16);
    const filename = `${id}.${ext}`;
    const filePath = path.join(this.dir, filename);
    const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, buffer, { mode: 0o640 });
    try {
      await fs.rename(tmp, filePath);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
    return {
      id,
      filename,
      url: this.buildUrl(filename),
      size: buffer.byteLength,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000)
    };
  }

  async stat(filename: string): Promise<{ mtimeMs: number; size: number } | null> {
    if (!FILENAME_RE.test(filename)) return null;
    try {
      const st = await fs.stat(this.resolve(filename));
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async read(filename: string): Promise<Buffer | null> {
    if (!FILENAME_RE.test(filename)) return null;
    try {
      return await fs.readFile(this.resolve(filename));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Delete files older than ttlSeconds. Returns count of files removed. */
  async cleanupOlderThan(ttlSeconds: number): Promise<number> {
    const cutoff = Date.now() - ttlSeconds * 1000;
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return 0;
    }
    let deleted = 0;
    for (const entry of entries) {
      // skip stray .tmp from interrupted writes — also age them out
      if (!FILENAME_RE.test(entry) && !entry.endsWith('.tmp')) continue;
      const full = path.join(this.dir, entry);
      try {
        const st = await fs.stat(full);
        if (st.mtimeMs < cutoff) {
          await fs.unlink(full);
          deleted++;
        }
      } catch {
        // skip transient race
      }
    }
    return deleted;
  }
}
