import pg from "pg";
import { pool } from "../db/client.js";

/**
 * Booking operations. Correctness-critical logic lives here, in explicit
 * transactions against Postgres (the single source of truth).
 *
 * Capacity rule: a slot is full when the number of ACTIVE rows for
 * (event_type_id, slot_start) reaches capacity. "Active" = confirmed, or held
 * with a hold_expires_at still in the future. Expired and cancelled rows never
 * count, and a held row past its expiry is treated as free even before the
 * sweep marks it expired — so correctness never depends on the worker running.
 *
 * Concurrency: two guests racing for the last seat in the same slot must not
 * both succeed. We serialize them with a transaction-scoped Postgres advisory
 * lock keyed on (event_type_id, slot_start). Advisory locks (rather than row
 * locks) let us guard a slot that may have zero existing rows — there is no row
 * to SELECT ... FOR UPDATE on the first booking of a slot. The lock is held
 * only for the few statements of the hold and released at COMMIT/ROLLBACK.
 */

export class BookingError extends Error {
  constructor(
    public code:
      | "slot_full"
      | "not_found"
      | "conflict"
      | "expired"
      | "invalid_state",
    message: string,
  ) {
    super(message);
    this.name = "BookingError";
  }
}

export interface BookingRow {
  id: string;
  event_type_id: string;
  // timestamptz values may arrive from the pg driver as Date or string.
  slot_start: Date | string;
  slot_end: Date | string;
  status: "held" | "confirmed" | "cancelled" | "expired";
  hold_expires_at: Date | string | null;
  guest_name: string | null;
  guest_email: string | null;
  manage_token: string;
  idempotency_key: string | null;
  cancel_reason: string | null;
}

/** Coerce a pg timestamptz (Date or string) to epoch millis for comparison. */
function toMillis(value: Date | string | null): number {
  if (value === null || value === undefined) return NaN;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Coerce a pg timestamptz (Date or string) to a canonical ISO string. */
function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Build two 32-bit lock keys from an event type UUID and a slot-start instant.
 * pg_advisory_xact_lock(int, int) partitions the lock space; collisions only
 * cause unnecessary serialization, never incorrectness.
 */
function slotLockKeys(eventTypeId: string, slotStartIso: string): [number, number] {
  const hash = (s: string): number => {
    let h = 2166136261 >>> 0; // FNV-1a
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    // Convert to signed 32-bit for Postgres int4.
    return h | 0;
  };
  return [hash(eventTypeId), hash(slotStartIso)];
}

/** Count active (capacity-consuming) rows for a slot, within a transaction. */
async function countActive(
  client: pg.PoolClient,
  eventTypeId: string,
  slotStartIso: string,
): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM bookings
      WHERE event_type_id = $1
        AND slot_start = $2
        AND (
          status = 'confirmed'
          OR (status = 'held' AND hold_expires_at > now())
        )`,
    [eventTypeId, slotStartIso],
  );
  return Number.parseInt(rows[0].n, 10);
}

export interface HoldInput {
  eventTypeId: string;
  slotStartIso: string;
  slotEndIso: string;
  capacity: number;
  holdTtlMinutes: number;
  idempotencyKey: string | null;
  guestName?: string | null;
  guestEmail?: string | null;
}

/**
 * Hold a slot. Idempotent on (event_type_id, idempotency_key): a retried
 * request with the same key returns the existing hold instead of creating a
 * second. Throws BookingError("slot_full") when capacity is reached.
 */
export async function holdSlot(input: HoldInput): Promise<BookingRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Serialize all holds for this exact slot FIRST. Taking the lock before the
    // idempotency check closes the race where several same-key requests all see
    // "no existing row" and then compete for capacity: here only the first past
    // the lock inserts, and everyone after it re-reads the committed row below.
    const [k1, k2] = slotLockKeys(input.eventTypeId, input.slotStartIso);
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [k1, k2]);

    // Idempotency: if this key already produced a row, return it. Checked inside
    // the lock so a same-key retry always resolves to the existing hold rather
    // than racing the capacity check.
    if (input.idempotencyKey) {
      const existing = await client.query<BookingRow>(
        `SELECT * FROM bookings
          WHERE event_type_id = $1 AND idempotency_key = $2`,
        [input.eventTypeId, input.idempotencyKey],
      );
      if (existing.rows.length > 0) {
        await client.query("COMMIT");
        return existing.rows[0];
      }
    }

    const active = await countActive(client, input.eventTypeId, input.slotStartIso);
    if (active >= input.capacity) {
      await client.query("ROLLBACK");
      throw new BookingError("slot_full", "This slot is fully booked.");
    }

    const inserted = await client.query<BookingRow>(
      `INSERT INTO bookings
         (event_type_id, slot_start, slot_end, status, hold_expires_at,
          guest_name, guest_email, idempotency_key)
       VALUES ($1, $2, $3, 'held', now() + ($4 || ' minutes')::interval, $5, $6, $7)
       RETURNING *`,
      [
        input.eventTypeId,
        input.slotStartIso,
        input.slotEndIso,
        String(input.holdTtlMinutes),
        input.guestName ?? null,
        input.guestEmail ?? null,
        input.idempotencyKey,
      ],
    );

    await client.query("COMMIT");
    return inserted.rows[0];
  } catch (err) {
    // Best-effort rollback if we errored mid-transaction.
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    // A unique-violation on the idempotency key means a concurrent retry won
    // the race; fetch and return that row.
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "23505" &&
      input.idempotencyKey
    ) {
      const { rows } = await pool.query<BookingRow>(
        `SELECT * FROM bookings WHERE event_type_id = $1 AND idempotency_key = $2`,
        [input.eventTypeId, input.idempotencyKey],
      );
      if (rows.length > 0) return rows[0];
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Confirm a held booking with guest details. */
export async function confirmHold(
  holdId: string,
  guestName: string,
  guestEmail: string,
): Promise<BookingRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<BookingRow>(
      `SELECT * FROM bookings WHERE id = $1 FOR UPDATE`,
      [holdId],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      throw new BookingError("not_found", "Hold not found.");
    }
    const booking = rows[0];

    if (booking.status === "confirmed") {
      // Idempotent confirm: already confirmed, return as-is.
      await client.query("COMMIT");
      return booking;
    }
    if (booking.status !== "held") {
      await client.query("ROLLBACK");
      throw new BookingError("invalid_state", `Cannot confirm a ${booking.status} booking.`);
    }
    if (booking.hold_expires_at && toMillis(booking.hold_expires_at) <= Date.now()) {
      await client.query("ROLLBACK");
      throw new BookingError("expired", "This hold has expired. Please pick the slot again.");
    }

    const updated = await client.query<BookingRow>(
      `UPDATE bookings
          SET status = 'confirmed',
              hold_expires_at = NULL,
              guest_name = $2,
              guest_email = $3,
              updated_at = now()
        WHERE id = $1
      RETURNING *`,
      [holdId, guestName, guestEmail],
    );

    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Look up a booking by its manage token (guest link). */
export async function getByManageToken(token: string): Promise<BookingRow | null> {
  const { rows } = await pool.query<BookingRow>(
    `SELECT * FROM bookings WHERE manage_token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

/** Cancel a confirmed or held booking with a reason. */
export async function cancelBooking(
  token: string,
  reason: string,
): Promise<BookingRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<BookingRow>(
      `SELECT * FROM bookings WHERE manage_token = $1 FOR UPDATE`,
      [token],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      throw new BookingError("not_found", "Booking not found.");
    }
    const booking = rows[0];
    if (booking.status === "cancelled") {
      await client.query("COMMIT");
      return booking; // idempotent
    }
    if (booking.status === "expired") {
      await client.query("ROLLBACK");
      throw new BookingError("invalid_state", "Cannot cancel an expired hold.");
    }

    const updated = await client.query<BookingRow>(
      `UPDATE bookings
          SET status = 'cancelled',
              cancel_reason = $2,
              hold_expires_at = NULL,
              updated_at = now()
        WHERE id = $1
      RETURNING *`,
      [booking.id, reason],
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reschedule a booking to a new slot. Atomically: take the new slot's capacity
 * (with the same advisory lock discipline as holdSlot) and, only if that
 * succeeds, move the booking. The old slot's capacity is freed by the move.
 */
export async function rescheduleBooking(
  token: string,
  newSlotStartIso: string,
  newSlotEndIso: string,
  capacity: number,
): Promise<BookingRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<BookingRow>(
      `SELECT * FROM bookings WHERE manage_token = $1 FOR UPDATE`,
      [token],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      throw new BookingError("not_found", "Booking not found.");
    }
    const booking = rows[0];
    if (booking.status !== "confirmed" && booking.status !== "held") {
      await client.query("ROLLBACK");
      throw new BookingError("invalid_state", `Cannot reschedule a ${booking.status} booking.`);
    }

    // No-op if moving to the same slot.
    if (toIsoString(booking.slot_start) === new Date(newSlotStartIso).toISOString()) {
      await client.query("COMMIT");
      return booking;
    }

    // Lock the destination slot and check capacity, excluding this booking.
    const [k1, k2] = slotLockKeys(booking.event_type_id, newSlotStartIso);
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [k1, k2]);

    const { rows: cnt } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM bookings
        WHERE event_type_id = $1
          AND slot_start = $2
          AND id <> $3
          AND (status = 'confirmed' OR (status = 'held' AND hold_expires_at > now()))`,
      [booking.event_type_id, newSlotStartIso, booking.id],
    );
    if (Number.parseInt(cnt[0].n, 10) >= capacity) {
      await client.query("ROLLBACK");
      throw new BookingError("slot_full", "The new slot is fully booked.");
    }

    const updated = await client.query<BookingRow>(
      `UPDATE bookings
          SET slot_start = $2,
              slot_end = $3,
              updated_at = now()
        WHERE id = $1
      RETURNING *`,
      [booking.id, newSlotStartIso, newSlotEndIso],
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Count active bookings per slot_start for an event type (for slot filtering). */
export async function activeCountsBySlot(
  eventTypeId: string,
  fromIso: string,
  toIso: string,
): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ slot_start: Date | string; n: string }>(
    `SELECT slot_start, count(*)::text AS n
       FROM bookings
      WHERE event_type_id = $1
        AND slot_start >= $2
        AND slot_start < $3
        AND (status = 'confirmed' OR (status = 'held' AND hold_expires_at > now()))
      GROUP BY slot_start`,
    [eventTypeId, fromIso, toIso],
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(toIsoString(r.slot_start), Number.parseInt(r.n, 10));
  return map;
}

/** Mark all held rows whose hold_expires_at has passed as expired. */
export async function expireStaleHolds(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE bookings
        SET status = 'expired', updated_at = now()
      WHERE status = 'held' AND hold_expires_at <= now()`,
  );
  return rowCount ?? 0;
}
