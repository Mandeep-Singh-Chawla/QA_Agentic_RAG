/** Simple retry with exponential backoff for flaky upstream APIs. */

export type RetryOpts = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  retryOn?: (err: unknown, res?: Response) => boolean;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function defaultShouldRetry(err: unknown, res?: Response): boolean {
  if (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return /fetch failed|ECONNRESET|ETIMEDOUT|socket|429|502|503|504/i.test(
      msg
    );
  }
  if (!res) return false;
  return res.status === 429 || res.status >= 500;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 300;
  const max = opts.maxDelayMs ?? 4000;
  const retryOn = opts.retryOn ?? defaultShouldRetry;
  let lastErr: unknown;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i >= attempts || !retryOn(err)) throw err;
      const delay = Math.min(max, base * 2 ** (i - 1));
      await sleep(delay);
    }
  }
  throw lastErr;
}

export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  opts?: RetryOpts
): Promise<Response> {
  return withRetry(async () => {
    const res = await fetch(input, init);
    if (defaultShouldRetry(undefined, res)) {
      const err = new Error(`HTTP ${res.status} ${opts?.label ?? ""}`.trim());
      (err as any).response = res;
      throw err;
    }
    return res;
  }, opts);
}
