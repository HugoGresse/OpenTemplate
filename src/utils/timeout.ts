/**
 * Race a promise against a hard timeout. Rejects with TimeoutError on expiry.
 * Note: the underlying work is NOT cancelled — caller must wire cancellation
 * (e.g. close the Puppeteer page) separately if needed.
 */
export class TimeoutError extends Error {
  constructor(ms: number, label: string) {
    super(`timeout:${label}:${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'op'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
