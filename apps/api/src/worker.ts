import { expireStaleHolds } from "./domain/bookings.js";

/**
 * Hold-expiry sweep. Periodically marks held rows whose hold_expires_at has
 * passed as `expired`.
 *
 * Note: correctness does NOT depend on this worker. Capacity queries already
 * treat a held row past its expiry as free (hold_expires_at > now()), so an
 * unconfirmed hold stops consuming capacity the instant it expires, whether or
 * not the sweep has run. The sweep only keeps the table tidy and makes the
 * lifecycle state (`expired`) accurate for reporting.
 */
export function startHoldExpiryWorker(intervalMs = 30_000): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const n = await expireStaleHolds();
      if (n > 0) {
        // eslint-disable-next-line no-console
        console.log(`[worker] expired ${n} stale hold(s)`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[worker] expiry sweep failed:", err);
    }
  };

  const handle = setInterval(tick, intervalMs);
  // Run once shortly after boot.
  setTimeout(tick, 1_000);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
