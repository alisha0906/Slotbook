import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { holdSlot, BookingError } from "../src/domain/bookings.js";
import {
  makePool,
  createTestEventType,
  cleanupTestEventType,
  countActiveRows,
  type TestEventType,
} from "./helpers.js";

/**
 * Concurrency / reliability tests against REAL Postgres.
 *
 * These prove Slotbook's central promise: under a burst of simultaneous
 * booking attempts, capacity is never exceeded — nobody is double-booked.
 *
 * Requires a running Postgres (docker compose up). The shared `pool` used by
 * the domain code reads DATABASE_URL; this test opens its own pool for setup
 * and assertions.
 */

let pool: pg.Pool;
const hostsToClean: string[] = [];

beforeAll(() => {
  pool = makePool();
});

afterEach(async () => {
  while (hostsToClean.length) {
    const id = hostsToClean.pop()!;
    await cleanupTestEventType(pool, id);
  }
});

afterAll(async () => {
  await pool.end();
});

/** Fire N holdSlot calls simultaneously; return how many succeeded vs. were rejected. */
async function race(
  et: TestEventType,
  attempts: number,
  opts: { sameIdempotencyKey?: string } = {},
): Promise<{ ok: number; full: number; other: number; results: PromiseSettledResult<unknown>[] }> {
  const calls = Array.from({ length: attempts }, (_, i) =>
    holdSlot({
      eventTypeId: et.eventTypeId,
      slotStartIso: et.slotStartIso,
      slotEndIso: et.slotEndIso,
      capacity: et.capacity,
      holdTtlMinutes: 5,
      idempotencyKey: opts.sameIdempotencyKey ?? `race-${i}-${Math.random()}`,
      guestName: `Guest ${i}`,
      guestEmail: `guest${i}@example.com`,
    }),
  );

  const results = await Promise.allSettled(calls);
  let ok = 0;
  let full = 0;
  let other = 0;
  for (const r of results) {
    if (r.status === "fulfilled") ok++;
    else if (r.reason instanceof BookingError && r.reason.code === "slot_full") full++;
    else other++;
  }
  return { ok, full, other, results };
}

describe("concurrency: no double-booking", () => {
  it("capacity 1: exactly one of 50 simultaneous holds wins", async () => {
    const et = await createTestEventType(pool, { capacity: 1 });
    hostsToClean.push(et.hostId);

    const { ok, full, other } = await race(et, 50);

    expect(other).toBe(0); // no unexpected errors
    expect(ok).toBe(1); // exactly one winner
    expect(full).toBe(49); // everyone else correctly rejected

    // Ground truth from the database: exactly one active row.
    const active = await countActiveRows(pool, et.eventTypeId, et.slotStartIso);
    expect(active).toBe(1);
  });

  it("capacity 5 (group): exactly five of 40 simultaneous holds win", async () => {
    const et = await createTestEventType(pool, { capacity: 5 });
    hostsToClean.push(et.hostId);

    const { ok, full, other } = await race(et, 40);

    expect(other).toBe(0);
    expect(ok).toBe(5); // capacity respected exactly
    expect(full).toBe(35);

    const active = await countActiveRows(pool, et.eventTypeId, et.slotStartIso);
    expect(active).toBe(5);
  });

  it("idempotency: same key across 20 concurrent holds yields a single booking", async () => {
    const et = await createTestEventType(pool, { capacity: 1 });
    hostsToClean.push(et.hostId);

    const key = `idem-${Math.random()}`;
    const { ok, other, results } = await race(et, 20, { sameIdempotencyKey: key });

    // All retries with the same key resolve to the SAME booking id — none throw.
    expect(other).toBe(0);
    expect(ok).toBe(20);

    const ids = new Set(
      results
        .filter((r): r is PromiseFulfilledResult<{ id: string }> => r.status === "fulfilled")
        .map((r) => r.value.id),
    );
    expect(ids.size).toBe(1); // one and only one booking created

    const active = await countActiveRows(pool, et.eventTypeId, et.slotStartIso);
    expect(active).toBe(1);
  });

  it("capacity 1: a second hold after the first still blocks (sequential sanity)", async () => {
    const et = await createTestEventType(pool, { capacity: 1 });
    hostsToClean.push(et.hostId);

    const first = await holdSlot({
      eventTypeId: et.eventTypeId,
      slotStartIso: et.slotStartIso,
      slotEndIso: et.slotEndIso,
      capacity: 1,
      holdTtlMinutes: 5,
      idempotencyKey: null,
    });
    expect(first.status).toBe("held");

    await expect(
      holdSlot({
        eventTypeId: et.eventTypeId,
        slotStartIso: et.slotStartIso,
        slotEndIso: et.slotEndIso,
        capacity: 1,
        holdTtlMinutes: 5,
        idempotencyKey: null,
      }),
    ).rejects.toMatchObject({ code: "slot_full" });
  });
});
