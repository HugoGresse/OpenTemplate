#!/usr/bin/env node
// Copy Monaco's "min/vs" assets into public/vendor/monaco/vs so the editor
// can serve them as same-origin static files. Self-hosting keeps the strict
// CSP (script-src 'self') usable without resorting to a third-party CDN.
//
// Runs as `postinstall`, so it executes on both `npm install` and `npm ci`.
// Idempotent: target dir is wiped and re-copied each run.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.resolve(root, 'node_modules/monaco-editor/min/vs');
const dst = path.resolve(root, 'public/vendor/monaco/vs');

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(s, d) {
  const stat = await fs.stat(s);
  if (stat.isDirectory()) {
    await fs.mkdir(d, { recursive: true });
    const entries = await fs.readdir(s);
    await Promise.all(entries.map((entry) => copyTree(path.join(s, entry), path.join(d, entry))));
  } else if (stat.isFile()) {
    await fs.copyFile(s, d);
  }
}

async function main() {
  if (!(await exists(src))) {
    // monaco-editor not installed yet (e.g. first dev install ordering) — skip gracefully
    console.warn(`[copy-monaco] source not found, skipping: ${src}`);
    return;
  }
  await fs.rm(dst, { recursive: true, force: true });
  await copyTree(src, dst);
  console.log(`[copy-monaco] copied ${src} -> ${dst}`);
}

main().catch((err) => {
  console.error('[copy-monaco] failed:', err);
  process.exit(1);
});
