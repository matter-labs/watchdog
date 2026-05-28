export const unwrap = <T>(value: T | undefined | null, label?: string): T => {
  if (value === undefined || value === null) {
    throw new Error(label ? `${label} is undefined or null` : "Value is undefined or null");
  }
  return value;
};

export const withLatency = async <T>(fn: () => Promise<T>): Promise<{ return: T; latency: number }> => {
  const start = Date.now();
  const ret = await fn();
  return { return: ret, latency: (Date.now() - start) / 1000 }; // in seconds for backward compatibility
};

export interface TimeoutCtx {
  signal: AbortSignal;
  timeoutMs: number;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Run `task` with a timeout. The task receives an AbortSignal and the
 * timeout budget in ms; it MUST forward these to any underlying long-lived
 * operations (ethers `waitForTransaction(hash, confirms, timeoutMs)`, fetch
 * `{ signal }`, etc.) so they clean themselves up when the timeout fires.
 *
 * Why this matters: Promises in JS cannot be cancelled. If the task starts a
 * poller (e.g. SDK `wait`) without a way to stop it, the poller keeps running
 * after this function rejects — that's a memory + CPU leak ("ghost task")
 * because each flow restart spawns another one on top of the still-running
 * previous ones.
 */
export const withTimeout = <T>(
  task: (ctx: TimeoutCtx) => Promise<T>,
  timeoutMs: number,
  context?: string
): Promise<T> => {
  const label = context ?? "Promise";
  const ac = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new TimeoutError(`${label} timed out after ${timeoutMs} ms`);
      ac.abort(err);
      reject(err);
    }, timeoutMs);
    task({ signal: ac.signal, timeoutMs })
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
};

export const timeoutPromise = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const SEC = 1000;
export const MIN = 60 * SEC;
