import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/utils/semaphore.js';

describe('Semaphore', () => {
  it('caps concurrent execution', async () => {
    const sem = new Semaphore(2);
    let concurrent = 0;
    let peak = 0;
    const task = async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
    };
    await Promise.all(Array.from({ length: 10 }, () => sem.run(task)));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('releases on rejection', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    // capacity should be available again
    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('rejects invalid capacity', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });

  it('reports queue depth', async () => {
    const sem = new Semaphore(1);
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((r) => (release = r));
    const p1 = sem.run(() => blocker);
    void sem.run(async () => undefined);
    void sem.run(async () => undefined);
    expect(sem.pending).toBe(2);
    expect(sem.inFlight).toBe(1);
    release();
    await p1;
  });
});
