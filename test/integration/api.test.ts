import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';

// Mock heavyweight engines so tests don't need Chromium/satori
vi.mock('../../src/engines/satori.js', () => ({
  warmupSatori: async () => undefined,
  renderSatoriPng: async () => Buffer.from('FAKE-SATORI-PNG')
}));

vi.mock('../../src/engines/puppeteer.js', () => ({
  shutdownPuppeteer: async () => undefined,
  puppeteerStats: () => ({ pagesServed: 0, inFlight: 0, pending: 0 }),
  renderPuppeteerPng: async () => Buffer.from('FAKE-PUPPETEER-PNG'),
  renderPuppeteerPdf: async () => Buffer.from('%PDF-FAKE')
}));

import { buildApp } from '../../src/server.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fs.rm(process.env.TEMPLATES_DIR!, { recursive: true, force: true });
});

const KEY = 'testkey-1';

describe('public routes', () => {
  it('/health is public and returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('/ redirects to /editor/', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/editor/');
  });

  it('/editor/ is public', async () => {
    const res = await app.inject({ method: 'GET', url: '/editor/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

describe('auth', () => {
  it('rejects request without key', async () => {
    const res = await app.inject({ method: 'GET', url: '/templates' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects bad key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/templates',
      headers: { 'x-api-key': 'wrong' }
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts via x-api-key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/templates',
      headers: { 'x-api-key': KEY }
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts via Authorization: Bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/templates',
      headers: { authorization: `Bearer ${KEY}` }
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('templates CRUD', () => {
  let createdId: string;

  it('creates a template', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/templates',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { name: 'demo', html: '<div>x</div>', width: 400, height: 200 }
    });
    expect(res.statusCode).toBe(201);
    const t = res.json();
    expect(t.id).toBeTruthy();
    createdId = t.id;
  });

  it('lists templates with pagination shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/templates?limit=10',
      headers: { 'x-api-key': KEY }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect('nextCursor' in body).toBe(true);
  });

  it('rejects invalid create payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/templates',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { name: 'x' } // missing html
    });
    expect(res.statusCode).toBe(400);
  });

  it('round-trips sampleData on create/get', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/templates',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: {
        name: 'with-data',
        html: '<div>{{name}}</div>',
        sampleData: { name: 'Alice', count: 3 }
      }
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    const got = await app.inject({
      method: 'GET',
      url: `/templates/${id}`,
      headers: { 'x-api-key': KEY }
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().sampleData).toEqual({ name: 'Alice', count: 3 });
  });

  it('PUT preserves sampleData when not in patch and overwrites when present', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/templates',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: {
        name: 't',
        html: '<div>{{x}}</div>',
        sampleData: { x: 1 }
      }
    });
    const id = create.json().id;

    // PUT without sampleData → should keep original
    const put1 = await app.inject({
      method: 'PUT',
      url: `/templates/${id}`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { name: 'renamed' }
    });
    expect(put1.json().sampleData).toEqual({ x: 1 });

    // PUT with new sampleData → should overwrite
    const put2 = await app.inject({
      method: 'PUT',
      url: `/templates/${id}`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { sampleData: { x: 99 } }
    });
    expect(put2.json().sampleData).toEqual({ x: 99 });
  });

  it('updates and deletes', async () => {
    const upd = await app.inject({
      method: 'PUT',
      url: `/templates/${createdId}`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { name: 'renamed' }
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().name).toBe('renamed');

    const del = await app.inject({
      method: 'DELETE',
      url: `/templates/${createdId}`,
      headers: { 'x-api-key': KEY }
    });
    expect(del.statusCode).toBe(200);
  });
});

describe('render endpoints', () => {
  it('rejects empty html', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/png',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: {}
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects pixel area over cap', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/png',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', width: 4000, height: 4000 }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_dimensions');
  });

  it('rejects invalid engine', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/png',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'imagemagick' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('renders PNG via mocked Satori', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/png',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'satori', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['x-engine']).toBe('satori');
    expect(res.rawPayload.toString()).toContain('FAKE-SATORI-PNG');
  });

  it('renders PDF via mocked Puppeteer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/pdf',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['x-engine']).toBe('puppeteer');
  });

  it('returns 404 for stored render with unknown id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/nonexistent/png',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: {}
    });
    expect(res.statusCode).toBe(404);
  });

  it('renders both PNG + PDF in a single bundle response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/bundle',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'satori', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json();
    // New shape: each format gets its own object holding {data}; legacy
    // top-level `png`/`pdf` strings are gone.
    expect(typeof body.png).toBe('object');
    expect(typeof body.png.data).toBe('string');
    expect(typeof body.pdf.data).toBe('string');
    expect(body.engineUsed).toEqual({ png: 'satori', pdf: 'puppeteer' });
    expect(Buffer.from(body.png.data, 'base64').toString()).toContain('FAKE-SATORI-PNG');
    expect(Buffer.from(body.pdf.data, 'base64').toString()).toContain('FAKE');
  });

  it('renders bundle for stored template', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/templates',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { name: 'bundle-test', html: '<div/>', width: 100, height: 100 }
    });
    const id = create.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/render/${id}/bundle`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { data: {} }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.png?.data).toBeTruthy();
    expect(body.pdf?.data).toBeTruthy();
  });

  it('?output=png+pdf on /render/png returns multi-format JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/png?output=png+pdf',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'satori', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json();
    expect(body.png.data).toBeTruthy();
    expect(body.pdf.data).toBeTruthy();
    expect(body.engineUsed).toEqual({ png: 'satori', pdf: 'puppeteer' });
  });

  it('?output=pdf on /render/png renders PDF only (binary)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/png?output=pdf',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'satori', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['x-engine']).toBe('puppeteer');
  });

  it('?store=data returns JSON base64 (no file written)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/png?store=data',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'satori', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json();
    expect(body.format).toBe('png');
    expect(typeof body.data).toBe('string');
    expect(body.url).toBeUndefined();
    expect(body.id).toBeUndefined();
    expect(Buffer.from(body.data, 'base64').toString()).toContain('FAKE-SATORI-PNG');
  });

  it('?store=url+data returns BOTH url and base64 data', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/png?store=url+data',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'satori', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.url).toBe(`/files/${body.id}.png`);
    expect(typeof body.data).toBe('string');
    expect(typeof body.size).toBe('number');
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('?store=url+data on bundle returns url and data per format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/bundle?store=url+data',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'satori', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.png.id).toBeTruthy();
    expect(body.png.url).toMatch(/^\/files\/.+\.png$/);
    expect(typeof body.png.data).toBe('string');
    expect(body.pdf.url).toMatch(/^\/files\/.+\.pdf$/);
    expect(typeof body.pdf.data).toBe('string');
  });

  it('?store=url returns JSON with url instead of binary (PNG)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/png?store=url',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'satori', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json();
    expect(body.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.url).toBe(`/files/${body.id}.png`);
    expect(body.format).toBe('png');
    expect(body.engineUsed).toBe('satori');
    expect(body.width).toBe(100);
    expect(body.height).toBe(100);
    expect(typeof body.size).toBe('number');
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('?store=url returns JSON for PDF too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/pdf?store=url',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe('pdf');
    expect(body.url).toBe(`/files/${body.id}.pdf`);
  });

  it('?store=url on bundle returns paired URLs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/bundle?store=url',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'satori', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.png.url).toMatch(/^\/files\/.+\.png$/);
    expect(body.pdf.url).toMatch(/^\/files\/.+\.pdf$/);
    expect(body.png.id).not.toBe(body.pdf.id);
    expect(body.engineUsed).toEqual({ png: 'satori', pdf: 'puppeteer' });
  });

  it('omitting ?store keeps binary response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/png',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'satori', width: 100, height: 100 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });

  it('GET /files/:filename serves the stored bytes (public, no API key)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/render/png?store=url',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', engine: 'satori', width: 100, height: 100 }
    });
    const { url } = create.json();
    const get = await app.inject({ method: 'GET', url });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.rawPayload.toString()).toContain('FAKE-SATORI-PNG');
  });

  it('GET /files/ rejects path-traversal-shaped filenames', async () => {
    for (const bad of ['../etc/passwd.png', 'foo bar.png', 'no-ext', 'no.ext.png/x']) {
      const res = await app.inject({
        method: 'GET',
        url: `/files/${encodeURIComponent(bad)}`
      });
      expect([400, 404]).toContain(res.statusCode);
    }
  });

  it('GET /files/:filename returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/files/nonexistent123.png' });
    expect(res.statusCode).toBe(404);
  });

  it('bundle rejects pixel cap violation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render/bundle',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { html: '<div/>', width: 4000, height: 4000 }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('AI', () => {
  it('does not expose any /ai routes — calls go browser-direct to OpenRouter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ai/generate',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: { model: 'foo', image: 'data:image/png;base64,iVBORw0KGgo=' }
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('error handling', () => {
  it('404 for unknown route includes requestId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nope-nope',
      headers: { 'x-api-key': KEY }
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().requestId).toMatch(/^req_/);
  });
});
