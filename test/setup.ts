import path from 'node:path';
import os from 'node:os';

// These env vars must be set BEFORE src/config.ts is imported anywhere
// in the test suite, hence the dedicated setup file referenced by vitest.config.
process.env.API_KEYS = process.env.API_KEYS ?? 'testkey-1,testkey-2';
process.env.AUTH_REQUIRED = process.env.AUTH_REQUIRED ?? 'true';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.TEMPLATES_DIR =
  process.env.TEMPLATES_DIR ??
  path.join(os.tmpdir(), `ot-itest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.FILES_DIR =
  process.env.FILES_DIR ??
  path.join(os.tmpdir(), `ot-files-${Date.now()}-${Math.random().toString(36).slice(2)}`);
