import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import {
  getEventTypeBySlug,
  getEventTypeById,
  getSchedule,
} from "../domain/eventTypes.js";
import { generateSlots, validateSlot } from "../domain/slots.js";
import {
  holdSlot,
  confirmHold,
  cancelBooking,
  rescheduleBooking,
  getByManageToken,
  activeCountsBySlot,
  BookingError,
} from "../domain/bookings.js";
import { emitNotification } from "../domain/notifications.js";

/**
 * Public booking API.
 *
 *   GET  /api/hosts/:host/events/:slug/slots?from&to&tz
 *   POST /api/holds                      (Idempotency-Key header)
 *   POST /api/holds/:id/confirm
 *   POST /api/bookings/:token/reschedule
 *   POST /api/bookings/:token/cancel
 */

function bookingErrorStatus(code: BookingError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "slot_full":
    case "conflict":
      return 409;
    case "expired":
    case "invalid_state":
      return 422;
    default:
      return 400;
  }
}

/**
 * Normalize a timestamp from a pg row to an ISO-8601 UTC string.
 * The pg driver may return timestamptz values as a Date or, depending on
 * driver/type parsing, as a string; handle both so serialization never throws.
 */
function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  // Already a string from the driver; coerce through Date to a canonical ISO.
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/** Shape a booking row for API responses (guest-facing). */
function serializeBooking(b: {
  id: string;
  event_type_id: string;
  slot_start: Date | string;
  slot_end: Date | string;
  status: string;
  hold_expires_at: Date | string | null;
  guest_name: string | null;
  guest_email: string | null;
  manage_token: string;
}) {
  return {
    id: b.id,
    eventTypeId: b.event_type_id,
    slotStart: toIso(b.slot_start),
    slotEnd: toIso(b.slot_end),
    status: b.status,
    holdExpiresAt: toIso(b.hold_expires_at),
    guestName: b.guest_name,
    guestEmail: b.guest_email,
    manageToken: b.manage_token,
  };
}

export async function registerBookingRoutes(app: FastifyInstance): Promise<void> {
  // --- GET slots -----------------------------------------------------------
  const slotsQuery = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    tz: z.string().optional(),
  });

  // Lightweight lookup: resolve a public host/event slug to the event type id
  // the hold endpoint needs. Guests never see ids elsewhere.
  app.get("/api/hosts/:host/events/:slug/id", async (req, reply) => {
    const { host, slug } = req.params as { host: string; slug: string };
    const eventType = await getEventTypeBySlug(host, slug);
    if (!eventType) {
      return reply.code(404).send({ error: "not_found", message: "Event type not found." });
    }
    return reply.send({ eventTypeId: eventType.id });
  });

  app.get("/api/hosts/:host/events/:slug/slots", async (req, reply) => {
    const { host, slug } = req.params as { host: string; slug: string };
    const parsed = slotsQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.issues });
    }
    const { from, to, tz } = parsed.data;

    const eventType = await getEventTypeBySlug(host, slug);
    if (!eventType) {
      return reply.code(404).send({ error: "not_found", message: "Event type not found." });
    }

    const displayTz = tz ?? eventType.hostTimeZone;
    if (!DateTime.local().setZone(displayTz).isValid) {
      return reply.code(400).send({ error: "invalid_timezone", message: `Unknown time zone: ${tz}` });
    }

    const nowUtc = DateTime.utc();
    const fromUtc = from ? DateTime.fromISO(from, { zone: "utc" }) : nowUtc;
    const toUtc = to
      ? DateTime.fromISO(to, { zone: "utc" })
      : nowUtc.plus({ days: eventType.horizonDays });
    if (!fromUtc.isValid || !toUtc.isValid) {
      return reply.code(400).send({ error: "invalid_range", message: "from/to must be ISO instants." });
    }

    const { weeklyRules, dateOverrides } = await getSchedule(eventType.id);

    const slots = generateSlots({
      hostTimeZone: eventType.hostTimeZone,
      durationMin: eventType.durationMin,
      bufferBeforeMin: eventType.bufferBeforeMin,
      bufferAfterMin: eventType.bufferAfterMin,
      minNoticeMin: eventType.minNoticeMin,
      horizonDays: eventType.horizonDays,
      weeklyRules,
      dateOverrides,
      fromUtc,
      toUtc,
      nowUtc,
    });

    // Filter out full slots using active counts.
    const counts = await activeCountsBySlot(
      eventType.id,
      fromUtc.toISO()!,
      toUtc.toISO()!,
    );
    const available = slots
      .map((s) => {
        const taken = counts.get(new Date(s.startUtc).toISOString()) ?? 0;
        const remaining = eventType.capacity - taken;
        return { ...s, remaining };
      })
      .filter((s) => s.remaining > 0);

    return {
      eventType: {
        name: eventType.name,
        slug: eventType.slug,
        durationMin: eventType.durationMin,
        capacity: eventType.capacity,
        hostName: eventType.hostName,
        hostSlug: eventType.hostSlug,
        hostTimeZone: eventType.hostTimeZone,
      },
      timeZone: displayTz,
      slots: available.map((s) => ({
        startUtc: s.startUtc,
        endUtc: s.endUtc,
        // Localized label in the requested zone for convenience.
        startLocal: DateTime.fromISO(s.startUtc, { zone: "utc" })
          .setZone(displayTz)
          .toISO({ suppressMilliseconds: true }),
        remaining: s.remaining,
      })),
    };
  });

  // --- POST hold -----------------------------------------------------------
  const holdBody = z.object({
    eventTypeId: z.string().uuid(),
    slotStart: z.string(),
    guestName: z.string().min(1).max(200).optional(),
    guestEmail: z.string().email().optional(),
  });

  app.post("/api/holds", async (req, reply) => {
    const parsed = holdBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    const { eventTypeId, slotStart, guestName, guestEmail } = parsed.data;
    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ?? null;

    const eventType = await getEventTypeById(eventTypeId);
    if (!eventType) {
      return reply.code(404).send({ error: "not_found", message: "Event type not found." });
    }

    const { weeklyRules, dateOverrides } = await getSchedule(eventType.id);

    // Re-validate that the requested start is a genuine, bookable slot.
    const slot = validateSlot(slotStart, {
      hostTimeZone: eventType.hostTimeZone,
      durationMin: eventType.durationMin,
      bufferBeforeMin: eventType.bufferBeforeMin,
      bufferAfterMin: eventType.bufferAfterMin,
      minNoticeMin: eventType.minNoticeMin,
      horizonDays: eventType.horizonDays,
      weeklyRules,
      dateOverrides,
      nowUtc: DateTime.utc(),
    });
    if (!slot) {
      return reply
        .code(422)
        .send({ error: "invalid_slot", message: "That slot is not bookable." });
    }

    try {
      const booking = await holdSlot({
        eventTypeId: eventType.id,
        slotStartIso: slot.startUtc,
        slotEndIso: slot.endUtc,
        capacity: eventType.capacity,
        holdTtlMinutes: config.holdTtlMinutes,
        idempotencyKey,
        guestName,
        guestEmail,
      });
      return reply.code(201).send(serializeBooking(booking));
    } catch (err) {
      if (err instanceof BookingError) {
        return reply
          .code(bookingErrorStatus(err.code))
          .send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // --- POST confirm --------------------------------------------------------
  const confirmBody = z.object({
    guestName: z.string().min(1).max(200),
    guestEmail: z.string().email(),
  });

  app.post("/api/holds/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = confirmBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    try {
      const booking = await confirmHold(id, parsed.data.guestName, parsed.data.guestEmail);
      await emitNotification(pool, "booking_confirmed", {
        bookingId: booking.id,
        eventTypeId: booking.event_type_id,
        guestName: booking.guest_name,
        guestEmail: booking.guest_email,
        slotStart: toIso(booking.slot_start)!,
        slotEnd: toIso(booking.slot_end)!,
        manageToken: booking.manage_token,
      });
      return reply.send(serializeBooking(booking));
    } catch (err) {
      if (err instanceof BookingError) {
        return reply
          .code(bookingErrorStatus(err.code))
          .send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // --- GET booking by manage token ----------------------------------------
  app.get("/api/bookings/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const booking = await getByManageToken(token);
    if (!booking) {
      return reply.code(404).send({ error: "not_found", message: "Booking not found." });
    }
    const eventType = await getEventTypeById(booking.event_type_id);
    return reply.send({
      booking: serializeBooking(booking),
      eventType: eventType
        ? {
            name: eventType.name,
            slug: eventType.slug,
            durationMin: eventType.durationMin,
            hostName: eventType.hostName,
            hostSlug: eventType.hostSlug,
            hostTimeZone: eventType.hostTimeZone,
          }
        : null,
    });
  });

  // --- POST reschedule -----------------------------------------------------
  const rescheduleBody = z.object({ slotStart: z.string() });

  app.post("/api/bookings/:token/reschedule", async (req, reply) => {
    const { token } = req.params as { token: string };
    const parsed = rescheduleBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }

    const booking = await getByManageToken(token);
    if (!booking) {
      return reply.code(404).send({ error: "not_found", message: "Booking not found." });
    }
    const eventType = await getEventTypeById(booking.event_type_id);
    if (!eventType) {
      return reply.code(404).send({ error: "not_found", message: "Event type not found." });
    }

    const { weeklyRules, dateOverrides } = await getSchedule(eventType.id);
    const slot = validateSlot(parsed.data.slotStart, {
      hostTimeZone: eventType.hostTimeZone,
      durationMin: eventType.durationMin,
      bufferBeforeMin: eventType.bufferBeforeMin,
      bufferAfterMin: eventType.bufferAfterMin,
      minNoticeMin: eventType.minNoticeMin,
      horizonDays: eventType.horizonDays,
      weeklyRules,
      dateOverrides,
      nowUtc: DateTime.utc(),
    });
    if (!slot) {
      return reply.code(422).send({ error: "invalid_slot", message: "That slot is not bookable." });
    }

    try {
      const updated = await rescheduleBooking(
        token,
        slot.startUtc,
        slot.endUtc,
        eventType.capacity,
      );
      await emitNotification(pool, "booking_rescheduled", {
        bookingId: updated.id,
        eventTypeId: updated.event_type_id,
        guestName: updated.guest_name,
        guestEmail: updated.guest_email,
        slotStart: toIso(updated.slot_start)!,
        slotEnd: toIso(updated.slot_end)!,
        manageToken: updated.manage_token,
      });
      return reply.send(serializeBooking(updated));
    } catch (err) {
      if (err instanceof BookingError) {
        return reply
          .code(bookingErrorStatus(err.code))
          .send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // --- POST cancel ---------------------------------------------------------
  const cancelBody = z.object({ reason: z.string().max(500).optional() });

  app.post("/api/bookings/:token/cancel", async (req, reply) => {
    const { token } = req.params as { token: string };
    const parsed = cancelBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
    }
    try {
      const booking = await cancelBooking(token, parsed.data.reason ?? "Cancelled by guest");
      await emitNotification(pool, "booking_cancelled", {
        bookingId: booking.id,
        eventTypeId: booking.event_type_id,
        guestName: booking.guest_name,
        guestEmail: booking.guest_email,
        slotStart: toIso(booking.slot_start)!,
        slotEnd: toIso(booking.slot_end)!,
        manageToken: booking.manage_token,
        extra: { reason: booking.cancel_reason },
      });
      return reply.send(serializeBooking(booking));
    } catch (err) {
      if (err instanceof BookingError) {
        return reply
          .code(bookingErrorStatus(err.code))
          .send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
