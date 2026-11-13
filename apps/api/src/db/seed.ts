import pg from "pg";
import { config } from "../config.js";

/**
 * Seeds a demo host with two event types so the app is usable immediately after
 * `docker compose up`. Idempotent: it upserts on the host slug and clears the
 * demo host's event types before reinserting, so reruns don't duplicate data.
 *
 * Demo host:
 *   slug:     demo
 *   timezone: America/New_York  (chosen so DST behaviour is easy to demonstrate)
 *
 * Event types:
 *   intro-call   30 min, capacity 1 (one-on-one)
 *   group-office 60 min, capacity 5 (group session)
 */

async function run(): Promise<void> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");

    // --- Host (upsert on slug) ---------------------------------------------
    // Password is stored as a plain seeded credential for the demo login.
    const hostRes = await client.query<{ id: string }>(
      `INSERT INTO hosts (name, slug, email, password_hash, timezone)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             email = EXCLUDED.email,
             password_hash = EXCLUDED.password_hash,
             timezone = EXCLUDED.timezone
       RETURNING id`,
      [
        "Demo Host",
        "demo",
        config.demoHostEmail,
        config.demoHostPassword,
        "America/New_York",
      ],
    );
    const hostId = hostRes.rows[0].id;

    // Clear existing event types for a clean reseed (cascades to rules/overrides).
    await client.query("DELETE FROM event_types WHERE host_id = $1", [hostId]);

    // --- Event type 1: one-on-one intro call -------------------------------
    const introRes = await client.query<{ id: string }>(
      `INSERT INTO event_types
         (host_id, name, slug, duration_min, capacity, buffer_before_min,
          buffer_after_min, min_notice_min, horizon_days)
       VALUES ($1, 'Intro Call', 'intro-call', 30, 1, 0, 10, 240, 30)
       RETURNING id`,
      [hostId],
    );
    const introId = introRes.rows[0].id;

    // --- Event type 2: group office hours ----------------------------------
    const groupRes = await client.query<{ id: string }>(
      `INSERT INTO event_types
         (host_id, name, slug, duration_min, capacity, buffer_before_min,
          buffer_after_min, min_notice_min, horizon_days)
       VALUES ($1, 'Group Office Hours', 'group-office', 60, 5, 0, 0, 120, 30)
       RETURNING id`,
      [hostId],
    );
    const groupId = groupRes.rows[0].id;

    // --- Weekly availability: Mon-Fri 09:00-17:00 for both event types -----
    for (const eventTypeId of [introId, groupId]) {
      for (let weekday = 1; weekday <= 5; weekday++) {
        await client.query(
          `INSERT INTO availability_rules (event_type_id, weekday, start_time, end_time)
           VALUES ($1, $2, '09:00', '17:00')`,
          [eventTypeId, weekday],
        );
      }
    }

    // --- A date override: intro-call closed next Monday --------------------
    await client.query(
      `INSERT INTO date_overrides (event_type_id, override_date, is_closed)
       VALUES ($1, (date_trunc('week', now()) + interval '1 week')::date, true)`,
      [introId],
    );

    await client.query("COMMIT");
    console.log("[seed] done — host 'demo' with event types 'intro-call' and 'group-office'");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[seed] failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

run();
