import { describe, it, expect } from 'vitest';
import { withTimeout, TimeoutError } from '../../src/utils/timeout.js';

describe('withTimeout', () => {
  it('resolves when promise finishes within budget', async () => {
    const result = await withTimeout(Promise.resolve(42), 100, 'test');
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError when budget exceeded', async () => {
    const slow = new Promise<number>((r) => setTimeout(() => r(1), 200));
    await expect(withTimeout(slow, 50, 'test')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('propagates underlying rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100, 'x')).rejects.toThrow('boom');
  });

  it('error message includes label and duration', async () => {
    const slow = new Promise<number>((r) => setTimeout(() => r(1), 100));
    await expect(withTimeout(slow, 25, 'render')).rejects.toThrow(/timeout:render:25ms/);
  });
});
