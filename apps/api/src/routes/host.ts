import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pool } from "../db/client.js";
import { cancelBooking, BookingError } from "../domain/bookings.js";
import { emitNotification } from "../domain/notifications.js";

/**
 * Host (authenticated) API.
 *
 *   POST /api/host/login                      -> { token, host }
 *   GET  /api/host/bookings                    -> upcoming bookings
 *   POST /api/host/bookings/:id/cancel         -> cancel with a reason
 *
 * Auth is intentionally simple for the take-home: a successful login returns an
 * opaque token that is just the host id (the brief permits a seeded login). A
 * real deployment would issue a signed session/JWT and hash passwords; this is
 * called out in the report's "known gaps".
 */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Resolve the authenticated host id from the Authorization: Bearer header. */
async function authHostId(req: FastifyRequest): Promise<string | null> {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  // Token is the host id; verify it exists.
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM hosts WHERE id = $1",
    [token],
  );
  return rows.length > 0 ? rows[0].id : null;
}

export async function registerHostRoutes(app: FastifyInstance): Promise<void> {
  // --- Login ---------------------------------------------------------------
  const loginBody = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });

  app.post("/api/host/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { email, password } = parsed.data;
    const { rows } = await pool.query<{
      id: string;
      name: string;
      slug: string;
      timezone: string;
      password_hash: string;
    }>(
      "SELECT id, name, slug, timezone, password_hash FROM hosts WHERE email = $1",
      [email],
    );
    // Plain comparison against the seeded credential (see module note).
    if (rows.length === 0 || rows[0].password_hash !== password) {
      return reply.code(401).send({ error: "invalid_credentials", message: "Wrong email or password." });
    }
    const host = rows[0];
    return reply.send({
      token: host.id,
      host: { id: host.id, name: host.name, slug: host.slug, timezone: host.timezone },
    });
  });

  // --- Upcoming bookings ---------------------------------------------------
  app.get("/api/host/bookings", async (req, reply) => {
    const hostId = await authHostId(req);
    if (!hostId) return reply.code(401).send({ error: "unauthorized" });

    const { rows } = await pool.query(
      `SELECT b.id, b.slot_start, b.slot_end, b.status, b.guest_name, b.guest_email,
              b.manage_token, e.name AS event_type_name, e.slug AS event_slug
         FROM bookings b
         JOIN event_types e ON e.id = b.event_type_id
        WHERE e.host_id = $1
          AND b.status IN ('held', 'confirmed')
          AND b.slot_start >= now()
        ORDER BY b.slot_start ASC`,
      [hostId],
    );

    return reply.send({
      bookings: rows.map((r) => ({
        id: r.id,
        eventTypeName: r.event_type_name,
        eventSlug: r.event_slug,
        slotStart: toIso(r.slot_start),
        slotEnd: toIso(r.slot_end),
        status: r.status,
        guestName: r.guest_name,
        guestEmail: r.guest_email,
        manageToken: r.manage_token,
      })),
    });
  });

  // --- Cancel a booking (host side) ---------------------------------------
  const cancelBody = z.object({ reason: z.string().max(500).optional() });

  app.post("/api/host/bookings/:id/cancel", async (req, reply) => {
    const hostId = await authHostId(req);
    if (!hostId) return reply.code(401).send({ error: "unauthorized" });

    const { id } = req.params as { id: string };
    const parsed = cancelBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    // Verify the booking belongs to this host and get its manage token.
    const { rows } = await pool.query<{ manage_token: string }>(
      `SELECT b.manage_token
         FROM bookings b
         JOIN event_types e ON e.id = b.event_type_id
        WHERE b.id = $1 AND e.host_id = $2`,
      [id, hostId],
    );
    if (rows.length === 0) {
      return reply.code(404).send({ error: "not_found", message: "Booking not found." });
    }

    try {
      const cancelled = await cancelBooking(
        rows[0].manage_token,
        parsed.data.reason ?? "Cancelled by host",
      );
      await emitNotification(pool, "booking_cancelled", {
        bookingId: cancelled.id,
        eventTypeId: cancelled.event_type_id,
        guestName: cancelled.guest_name,
        guestEmail: cancelled.guest_email,
        slotStart: toIso(cancelled.slot_start),
        slotEnd: toIso(cancelled.slot_end),
        manageToken: cancelled.manage_token,
        extra: { reason: cancelled.cancel_reason, cancelledBy: "host" },
      });
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof BookingError) {
        return reply.code(409).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
