/**
 * A simple mutex implementation that ensures only one operation can access a protected resource at a time.
 */
export class Mutex {
  private locked: boolean = false;
  private waitingQueue: Array<() => void> = [];

  /**
   * Acquires the lock. If the lock is already held, the calling code will wait until it's released.
   * @returns A promise that resolves when the lock is acquired
   */
  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      // If the lock is free, acquire it immediately
      if (!this.locked) {
        this.locked = true;
        resolve();
        return;
      }

      // Otherwise, add to the waiting queue
      this.waitingQueue.push(resolve);
    });
  }

  /**
   * Releases the lock and allows the next waiting operation to proceed.
   */
  release(): void {
    if (!this.locked) {
      throw new Error("Cannot release an unlocked mutex");
    }

    if (this.waitingQueue.length > 0) {
      // If there are waiting operations, let the next one proceed
      const nextResolve = this.waitingQueue.shift();
      if (nextResolve) {
        // Keep the lock marked as locked
        nextResolve();
      }
    } else {
      // No waiting operations, mark the lock as free
      this.locked = false;
    }
  }

  /**
   * Executes a function within a critical section, automatically acquiring and releasing the lock.
   * @param fn The function to execute while holding the lock
   * @returns A promise that resolves with the result of the function
   */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await Promise.resolve(fn());
    } finally {
      this.release();
    }
  }

  /**
   * Checks if the mutex is currently locked.
   * @returns True if the mutex is locked, false otherwise
   */
  isLocked(): boolean {
    return this.locked;
  }
}
