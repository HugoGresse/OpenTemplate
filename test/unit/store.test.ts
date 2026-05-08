import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TemplateStore } from '../../src/storage/fs.js';

async function makeTmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `ot-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe('TemplateStore', () => {
  let store: TemplateStore;
  let dir: string;

  beforeEach(async () => {
    dir = await makeTmpDir();
    store = new TemplateStore(dir);
    await store.init();
  });

  it('creates and retrieves a template', async () => {
    const t = await store.create({ name: 'test', html: '<div>x</div>' });
    expect(t.id).toMatch(/^[A-Za-z0-9_-]+$/);
    const got = await store.get(t.id);
    expect(got?.name).toBe('test');
    expect(got?.html).toBe('<div>x</div>');
  });

  it('returns null for unknown id', async () => {
    expect(await store.get('nope')).toBeNull();
  });

  it('rejects path traversal attempts in get', async () => {
    expect(await store.get('../../../etc/passwd')).toBeNull();
  });

  it('updates existing template, preserves createdAt', async () => {
    const t = await store.create({ name: 'a', html: '<div>1</div>' });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await store.update(t.id, { html: '<div>2</div>' });
    expect(updated?.html).toBe('<div>2</div>');
    expect(updated?.createdAt).toBe(t.createdAt);
    expect(updated?.updatedAt).not.toBe(t.createdAt);
  });

  it('returns null when updating missing id', async () => {
    expect(await store.update('missing', { html: '<x/>' })).toBeNull();
  });

  it('deletes a template', async () => {
    const t = await store.create({ name: 'to-del', html: '<x/>' });
    expect(await store.delete(t.id)).toBe(true);
    expect(await store.get(t.id)).toBeNull();
    expect(await store.delete(t.id)).toBe(false);
  });

  it('lists templates sorted by updatedAt desc', async () => {
    const a = await store.create({ name: 'a', html: '<x/>' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ name: 'b', html: '<x/>' });
    const { items } = await store.list();
    expect(items.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it('paginates with cursor', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const t = await store.create({ name: `t${i}`, html: '<x/>' });
      ids.push(t.id);
      await new Promise((r) => setTimeout(r, 2));
    }
    const page1 = await store.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await store.list({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    // pages should not overlap
    const ids1 = page1.items.map((t) => t.id);
    const ids2 = page2.items.map((t) => t.id);
    for (const id of ids1) expect(ids2).not.toContain(id);
  });

  it('writes are atomic — no .tmp files left behind on success', async () => {
    await store.create({ name: 'x', html: '<x/>' });
    const files = await fs.readdir(dir);
    expect(files.every((f) => !f.endsWith('.tmp'))).toBe(true);
  });

  it('handles concurrent updates without losing data', async () => {
    const t = await store.create({ name: 'c', html: '<x/>' });
    const updates = Array.from({ length: 20 }, (_, i) =>
      store.update(t.id, { name: `c${i}` })
    );
    const results = await Promise.all(updates);
    expect(results.every((r) => r !== null)).toBe(true);
    const final = await store.get(t.id);
    expect(final?.name).toMatch(/^c\d+$/);
    // no orphan tmp files
    const files = await fs.readdir(dir);
    expect(files.every((f) => !f.endsWith('.tmp'))).toBe(true);
  });
});
