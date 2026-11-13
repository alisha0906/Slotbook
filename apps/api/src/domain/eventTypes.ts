import { pool } from "../db/client.js";
import type { WeeklyRule, DateOverride } from "./slots.js";

/**
 * Loading event types together with their host time zone and schedule
 * (weekly availability + date overrides). Used by slot generation and the
 * hold/reschedule validation path.
 */

export interface EventTypeWithHost {
  id: string;
  hostId: string;
  hostSlug: string;
  hostName: string;
  hostTimeZone: string;
  name: string;
  slug: string;
  durationMin: number;
  capacity: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  horizonDays: number;
}

export interface EventSchedule {
  eventType: EventTypeWithHost;
  weeklyRules: WeeklyRule[];
  dateOverrides: DateOverride[];
}

/** Resolve an event type by host slug + event slug, with host time zone. */
export async function getEventTypeBySlug(
  hostSlug: string,
  eventSlug: string,
): Promise<EventTypeWithHost | null> {
  const { rows } = await pool.query(
    `SELECT e.id, e.host_id, e.name, e.slug, e.duration_min, e.capacity,
            e.buffer_before_min, e.buffer_after_min, e.min_notice_min, e.horizon_days,
            h.slug AS host_slug, h.name AS host_name, h.timezone AS host_timezone
       FROM event_types e
       JOIN hosts h ON h.id = e.host_id
      WHERE h.slug = $1 AND e.slug = $2`,
    [hostSlug, eventSlug],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    hostId: r.host_id,
    hostSlug: r.host_slug,
    hostName: r.host_name,
    hostTimeZone: r.host_timezone,
    name: r.name,
    slug: r.slug,
    durationMin: r.duration_min,
    capacity: r.capacity,
    bufferBeforeMin: r.buffer_before_min,
    bufferAfterMin: r.buffer_after_min,
    minNoticeMin: r.min_notice_min,
    horizonDays: r.horizon_days,
  };
}

/** Load an event type by id, with host time zone. */
export async function getEventTypeById(id: string): Promise<EventTypeWithHost | null> {
  const { rows } = await pool.query(
    `SELECT e.id, e.host_id, e.name, e.slug, e.duration_min, e.capacity,
            e.buffer_before_min, e.buffer_after_min, e.min_notice_min, e.horizon_days,
            h.slug AS host_slug, h.name AS host_name, h.timezone AS host_timezone
       FROM event_types e
       JOIN hosts h ON h.id = e.host_id
      WHERE e.id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    hostId: r.host_id,
    hostSlug: r.host_slug,
    hostName: r.host_name,
    hostTimeZone: r.host_timezone,
    name: r.name,
    slug: r.slug,
    durationMin: r.duration_min,
    capacity: r.capacity,
    bufferBeforeMin: r.buffer_before_min,
    bufferAfterMin: r.buffer_after_min,
    minNoticeMin: r.min_notice_min,
    horizonDays: r.horizon_days,
  };
}

/** Load weekly rules + date overrides for an event type. */
export async function getSchedule(eventTypeId: string): Promise<{
  weeklyRules: WeeklyRule[];
  dateOverrides: DateOverride[];
}> {
  const rulesRes = await pool.query(
    `SELECT weekday, to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time, 'HH24:MI') AS end_time
       FROM availability_rules
      WHERE event_type_id = $1`,
    [eventTypeId],
  );
  const overridesRes = await pool.query(
    `SELECT to_char(override_date, 'YYYY-MM-DD') AS override_date,
            is_closed,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time, 'HH24:MI') AS end_time
       FROM date_overrides
      WHERE event_type_id = $1`,
    [eventTypeId],
  );

  return {
    weeklyRules: rulesRes.rows.map((r) => ({
      weekday: r.weekday,
      startTime: r.start_time,
      endTime: r.end_time,
    })),
    dateOverrides: overridesRes.rows.map((r) => ({
      overrideDate: r.override_date,
      isClosed: r.is_closed,
      startTime: r.start_time,
      endTime: r.end_time,
    })),
  };
}
