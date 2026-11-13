import pg from "pg";

/**
 * Test helpers for integration tests that run against a REAL Postgres
 * (the same instance docker-compose exposes on localhost:5432). These tests
 * are the reliability proof for Slotbook's core promise — no double-booking —
 * so they deliberately avoid any mocking of the database.
 */

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://slotbook:slotbook@localhost:5432/slotbook";

export function makePool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 40 });
}

export interface TestEventType {
  hostId: string;
  eventTypeId: string;
  capacity: number;
  /** A fixed UTC slot start used by the race tests. */
  slotStartIso: string;
  slotEndIso: string;
}

/**
 * Create an isolated host + event type with wide-open availability and a known
 * bookable slot, so tests don't collide with seed data or each other. The host
 * slug is randomized per call. Returns IDs plus a concrete slot to race on.
 */
export async function createTestEventType(
  pool: pg.Pool,
  opts: { capacity: number; durationMin?: number },
): Promise<TestEventType> {
  const durationMin = opts.durationMin ?? 30;
  const suffix = Math.random().toString(36).slice(2, 10);

  const host = await pool.query<{ id: string }>(
    `INSERT INTO hosts (name, slug, email, password_hash, timezone)
     VALUES ('Test Host', $1, $2, 'x', 'UTC')
     RETURNING id`,
    [`test-${suffix}`, `test-${suffix}@slotbook.test`],
  );
  const hostId = host.rows[0].id;

  const et = await pool.query<{ id: string }>(
    `INSERT INTO event_types
       (host_id, name, slug, duration_min, capacity, buffer_before_min,
        buffer_after_min, min_notice_min, horizon_days)
     VALUES ($1, 'Race Event', 'race', $2, $3, 0, 0, 0, 365)
     RETURNING id`,
    [hostId, durationMin, opts.capacity],
  );
  const eventTypeId = et.rows[0].id;

  // Availability every weekday, all day, so any chosen slot is valid.
  for (let weekday = 0; weekday <= 6; weekday++) {
    await pool.query(
      `INSERT INTO availability_rules (event_type_id, weekday, start_time, end_time)
       VALUES ($1, $2, '00:00', '23:59')`,
      [eventTypeId, weekday],
    );
  }

  // A concrete slot ~2 days out, aligned to a whole hour in UTC.
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2);
  start.setUTCHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + durationMin * 60_000);

  return {
    hostId,
    eventTypeId,
    capacity: opts.capacity,
    slotStartIso: start.toISOString(),
    slotEndIso: end.toISOString(),
  };
}

/** Remove a test host and everything cascading from it. */
export async function cleanupTestEventType(pool: pg.Pool, hostId: string): Promise<void> {
  await pool.query("DELETE FROM hosts WHERE id = $1", [hostId]);
}

/** Count active (capacity-consuming) rows for a slot. */
export async function countActiveRows(
  pool: pg.Pool,
  eventTypeId: string,
  slotStartIso: string,
): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM bookings
      WHERE event_type_id = $1 AND slot_start = $2
        AND (status = 'confirmed' OR (status = 'held' AND hold_expires_at > now()))`,
    [eventTypeId, slotStartIso],
  );
  return Number.parseInt(rows[0].n, 10);
}
