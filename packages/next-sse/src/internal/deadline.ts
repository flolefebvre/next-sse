/** How an operation that ran out of time failed: what tells a deadline from a backend error. */
export class DeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`the operation did not complete within ${String(timeoutMs)}ms`);
    this.name = "DeadlineError";
  }
}

/**
 * Run one operation under a deadline: what it gives back if it finishes in time, its own
 * failure if it fails, and a `DeadlineError` once `timeoutMs` has passed.
 *
 * The deadline is taken around the whole awaited operation rather than on the commands it
 * sends: a command already written to a stalled server is waiting for a reply that never comes,
 * which no per-command timeout of node-redis reaches, and a wait on the connection itself is no
 * command at all.
 *
 * Nothing is cancelled — an operation past its deadline runs on to whatever end it reaches, and
 * its result is dropped. The timer is unref'd and cleared as soon as either side settles, so a
 * bounded operation never holds a process open.
 */
export async function withDeadline<T>(timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiring = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineError(timeoutMs));
    }, timeoutMs).unref();
  });

  try {
    return await Promise.race([operation(), expiring]);
  } finally {
    clearTimeout(timer);
  }
}
