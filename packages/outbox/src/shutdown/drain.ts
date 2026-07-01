/**
 * Default drain budget for the outbox background workers, in
 * milliseconds.
 *
 * Sized against platform grace periods rather than against any
 * particular listener: Kubernetes' `terminationGracePeriodSeconds`
 * defaults to 30s, and the rest of the shutdown path (closing the
 * connection pool, flushing logs) needs room after the drain. 10s
 * leaves that margin.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Await `inFlight`, giving up after `timeoutMs`.
 *
 * Resolves `true` when the work finished within the budget and `false`
 * when the budget ran out first. A `timeoutMs` of `0` means "do not
 * wait at all" and reports `false` without awaiting anything.
 *
 * The abandoned work is NOT cancelled — there is no safe way to
 * interrupt a half-finished listener invocation or SQL statement. The
 * caller's contract is weaker and deliberately so: shutdown proceeds,
 * and whatever was left mid-flight is recovered on the next boot by
 * the staleness monitor / startup recovery. Blocking shutdown
 * indefinitely on user code would be the worse failure — a deployment
 * that never completes.
 *
 * Never rejects: both the processor's `processBatch` and the monitor's
 * `checkStaleness` already swallow their own failures, and a drain that
 * threw would turn an orderly shutdown into an unhandled rejection.
 */
export async function drainWithTimeout(
  inFlight: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  if (timeoutMs <= 0) {
    return false;
  }

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    // Do not hold the event loop open purely to police the deadline —
    // if everything else has finished, the process should be free to
    // exit.
    timer.unref?.();
  });

  try {
    return await Promise.race([inFlight.then(() => true), expired]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
