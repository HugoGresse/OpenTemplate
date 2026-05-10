import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { Mutex } from 'async-mutex';

export type Engine = 'satori' | 'puppeteer' | 'auto';

export interface Template {
  id: string;
  name: string;
  html: string;
  css?: string;
  width?: number;
  height?: number;
  engine?: Engine;
  /**
   * Default data for {{var}} interpolation. Used by the editor to round-trip
   * the JSON pane and as a fallback by /render/:id/* when the caller doesn't
   * supply `data` in the body.
   *
   * Hyperlinks: include `_links` in this object — `{ "<otid>": "https://..." }`
   * or `{ "<otid>": { "url": "...", "title": "..." } }`. The render pipeline
   * extracts `_links`, wraps matched elements with <a>, then interpolates the
   * remaining keys via Mustache.
   */
  sampleData?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type TemplateInput = Omit<Template, 'id' | 'createdAt' | 'updatedAt'>;

export interface ListOptions {
  limit?: number;
  cursor?: string; // updatedAt of last item from previous page
}

export interface ListResult {
  items: Template[];
  nextCursor: string | null;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Filesystem-backed template store.
 *
 * - Per-id mutex prevents concurrent write corruption on the same template.
 * - Writes go to a temp file then atomically renamed.
 * - In-memory index avoids a full directory scan on each `list()` call.
 */
export class TemplateStore {
  private readonly mutexes = new Map<string, Mutex>();
  private indexPromise: Promise<Map<string, Template>> | null = null;

  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await this.loadIndex();
  }

  private mutexFor(id: string): Mutex {
    let m = this.mutexes.get(id);
    if (!m) {
      m = new Mutex();
      this.mutexes.set(id, m);
    }
    return m;
  }

  private filePath(id: string): string {
    if (!ID_RE.test(id)) throw new Error('invalid_template_id');
    return path.join(this.dir, `${id}.json`);
  }

  private async loadIndex(): Promise<Map<string, Template>> {
    if (this.indexPromise) return this.indexPromise;
    this.indexPromise = (async () => {
      const map = new Map<string, Template>();
      const files = await fs.readdir(this.dir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(this.dir, f), 'utf8');
          const t = JSON.parse(raw) as Template;
          if (t && typeof t.id === 'string' && ID_RE.test(t.id)) {
            map.set(t.id, t);
          }
        } catch {
          // skip unreadable / malformed
        }
      }
      return map;
    })();
    return this.indexPromise;
  }

  private async writeAtomic(id: string, data: Template): Promise<void> {
    const finalPath = this.filePath(id);
    const tmpPath = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
    const json = JSON.stringify(data, null, 2);
    await fs.writeFile(tmpPath, json, { mode: 0o640 });
    try {
      await fs.rename(tmpPath, finalPath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  async list(opts: ListOptions = {}): Promise<ListResult> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const index = await this.loadIndex();
    const all = [...index.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const startIdx = opts.cursor
      ? all.findIndex((t) => t.updatedAt < opts.cursor!) // strict < so cursor item is excluded
      : 0;
    const sliced = startIdx < 0 ? [] : all.slice(startIdx, startIdx + limit);
    const nextCursor = sliced.length === limit ? (sliced.at(-1)?.updatedAt ?? null) : null;
    return { items: sliced, nextCursor };
  }

  async get(id: string): Promise<Template | null> {
    if (!ID_RE.test(id)) return null;
    const index = await this.loadIndex();
    return index.get(id) ?? null;
  }

  async create(input: TemplateInput): Promise<Template> {
    const now = new Date().toISOString();
    const t: Template = { ...input, id: nanoid(10), createdAt: now, updatedAt: now };
    await this.mutexFor(t.id).runExclusive(async () => {
      await this.writeAtomic(t.id, t);
      const index = await this.loadIndex();
      index.set(t.id, t);
    });
    return t;
  }

  async update(
    id: string,
    patch: Partial<Omit<Template, 'id' | 'createdAt'>>
  ): Promise<Template | null> {
    if (!ID_RE.test(id)) return null;
    return this.mutexFor(id).runExclusive(async () => {
      const index = await this.loadIndex();
      const existing = index.get(id);
      if (!existing) return null;
      const updated: Template = {
        ...existing,
        ...patch,
        id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString()
      };
      await this.writeAtomic(id, updated);
      index.set(id, updated);
      return updated;
    });
  }

  async delete(id: string): Promise<boolean> {
    if (!ID_RE.test(id)) return false;
    return this.mutexFor(id).runExclusive(async () => {
      const index = await this.loadIndex();
      if (!index.has(id)) return false;
      try {
        await fs.unlink(this.filePath(id));
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e?.code !== 'ENOENT') throw err;
      }
      index.delete(id);
      this.mutexes.delete(id);
      return true;
    });
  }
}
