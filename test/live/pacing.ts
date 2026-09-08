/**
 * Quota pacing for the live suites.
 *
 * **Every live test file must build its context through `paceContext`.** New
 * ones included. The suites share one Google project and one per-user quota,
 * so a file that opts out does not only risk its own cases, it spends the
 * budget the other files are counting on.
 *
 * The problem this solves is not rare and does not look like what it is.
 * Sheets allows sixty reads and sixty writes a minute per user. A live case
 * spends three or four calls inside the tool and one or two more reading the
 * result back, so twenty cases run flat out will cross the line partway
 * through. What comes back then is a 429 in the middle of an assertion, which
 * surfaces as `expected 'ok' to be 'success'` or a missing row, and reads as a
 * tool bug. Two people have now spent time chasing one.
 *
 * So rather than asking every call site to remember something, this wraps the
 * shared Google clients once. Every method call on `ctx.sheets` and
 * `ctx.drive` passes through a token bucket that holds the rate under the
 * limit, and through a short retry so a 429 that slips past waits rather than
 * failing. The tools the tests exercise use the same client, so their internal
 * calls are paced too, which is the reason for wrapping the client instead of
 * pausing between cases: a fixed pause taxes every run equally whether or not
 * it is near the limit, and still misses the calls made inside a tool.
 *
 * Usage, in `beforeAll`:
 *
 *     ctx = paceContext(await getContext());
 *
 * That is the whole contract. Nothing else in the file changes.
 */

import { withRetry } from "../../src/lib/batch.js";
import type { Context } from "../../src/lib/client.js";

/** The window the quota is measured over. */
export const WINDOW_MS = 60_000;

/**
 * Calls allowed per window. Sheets permits sixty reads and sixty writes a
 * minute as separate budgets; one shared bucket of fifty is deliberately
 * conservative, because a live suite that runs slightly slow is better than
 * one that fails in a way nobody can read.
 */
export const MAX_CALLS_PER_WINDOW = 50;

/**
 * Retries the wrapper adds on top of whatever the caller already does.
 *
 * Deliberately small. The tools wrap their own calls in `withRetry` already,
 * and a wrapper that retries four times around code that retries four times
 * turns a spent quota into fifteen minutes of backoff instead of a prompt
 * failure. Two is enough to ride out a blip the bucket did not prevent.
 */
export const WRAPPER_RETRIES = 2;

class TokenBucket {
  private readonly times: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Wait until a call is allowed, then record it. */
  async take(): Promise<void> {
    for (;;) {
      const cutoff = this.now() - this.windowMs;
      while (this.times.length > 0 && this.times[0] <= cutoff) this.times.shift();
      if (this.times.length < this.max) {
        this.times.push(this.now());
        return;
      }
      // The oldest call is what frees a slot, so wait exactly that long.
      const waitMs = this.times[0] - cutoff + 50;
      await this.sleep(waitMs);
    }
  }

  /** How many calls have been made in the current window. Exposed for tests. */
  get inFlightWindow(): number {
    const cutoff = this.now() - this.windowMs;
    return this.times.filter((t) => t > cutoff).length;
  }
}

/**
 * One bucket for the whole run.
 *
 * Vitest runs the live files in one process with `fileParallelism: false`, so
 * a module-scope bucket really is shared across every file. If that ever
 * changes, the pacing weakens to per-file and the suites will need a real
 * cross-process limiter.
 */
const bucket = new TokenBucket(MAX_CALLS_PER_WINDOW, WINDOW_MS);

/** A fresh bucket, for testing the limiter itself. */
export function createBucket(
  max: number,
  windowMs: number,
  now?: () => number,
  sleep?: (ms: number) => Promise<void>,
): { take(): Promise<void>; readonly inFlightWindow: number } {
  return new TokenBucket(max, windowMs, now, sleep);
}

type Limiter = { take(): Promise<void> };

/**
 * Wrap an API client so every method call is paced and retried.
 *
 * The generated Google clients are plain nested objects of methods, so a
 * recursive proxy reaches all of them without naming any. Methods are invoked
 * against their own parent rather than the proxy, so `this` inside the client
 * is what the library expects.
 */
function pace<T extends object>(client: T, limiter: Limiter): T {
  const cache = new Map<PropertyKey, unknown>();

  return new Proxy(client, {
    get(target, property) {
      if (cache.has(property)) return cache.get(property);

      const value = (target as Record<PropertyKey, unknown>)[property];

      if (typeof value === "function") {
        const paced = async (...args: unknown[]) => {
          await limiter.take();
          return withRetry(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args), {
            retries: WRAPPER_RETRIES,
          });
        };
        cache.set(property, paced);
        return paced;
      }

      if (value && typeof value === "object") {
        const wrapped = pace(value as object, limiter);
        cache.set(property, wrapped);
        return wrapped;
      }

      return value;
    },
  }) as T;
}

/**
 * The one call a live suite makes. Returns the same context with its Google
 * clients paced, so both the tests' own calls and the tools' internal ones
 * stay under quota.
 */
export function paceContext(context: Context, limiter: Limiter = bucket): Context {
  return {
    ...context,
    sheets: pace(context.sheets as unknown as object, limiter) as Context["sheets"],
    drive: pace(context.drive as unknown as object, limiter) as Context["drive"],
  };
}

/** How many API calls the shared bucket has seen this window. For reporting. */
export function callsThisWindow(): number {
  return bucket.inFlightWindow;
}
