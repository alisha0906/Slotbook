import type pg from "pg";

/**
 * Notifications sink.
 *
 * On confirm / reschedule / cancel we emit an event by writing a row to the
 * `notifications` table. This stands in for a real email/webhook provider; the
 * payload carries everything a downstream consumer would need.
 *
 * Writes go through the same client/transaction as the booking change when a
 * client is passed, so a notification is never emitted for a change that rolled
 * back.
 */

export type NotificationType =
  | "booking_confirmed"
  | "booking_rescheduled"
  | "booking_cancelled";

export interface NotificationPayload {
  bookingId: string;
  eventTypeId: string;
  guestName: string | null;
  guestEmail: string | null;
  slotStart: string;
  slotEnd: string;
  manageToken: string;
  extra?: Record<string, unknown>;
}

export async function emitNotification(
  executor: pg.PoolClient | pg.Pool,
  type: NotificationType,
  payload: NotificationPayload,
): Promise<void> {
  await executor.query(
    `INSERT INTO notifications (booking_id, type, payload)
     VALUES ($1, $2, $3)`,
    [payload.bookingId, type, JSON.stringify(payload)],
  );
}
