export const unwrap = <T>(value: T | undefined | null): T => {
  if (value === undefined || value === null) {
    throw new Error("Value is undefined or null");
  }
  return value;
};

export const withLatency = async <T>(fn: () => Promise<T>): Promise<{ return: T; latency: number }> => {
  const start = Date.now();
  const ret = await fn();
  return { return: ret, latency: (Date.now() - start) / 1000 }; // in seconds for backword compatibility
};

export const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, context?: string): Promise<T> => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${context ?? "Promise"} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeout);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
};

export const timeoutPromise = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const SEC = 1000;
export const MIN = 60 * SEC;
