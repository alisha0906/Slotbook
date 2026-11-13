import { DateTime, Interval } from "luxon";

/**
 * Slot generation — the time-zone-correct core of Slotbook.
 *
 * Availability is stored as local wall-clock windows (e.g. 09:00-17:00) in the
 * host's IANA time zone. To produce bookable slots we:
 *
 *   1. Walk each calendar day in the host's time zone over the requested range.
 *   2. For each day, pick the applicable windows: a date override if present,
 *      otherwise the weekly rules for that weekday.
 *   3. Within each window, step forward by the slot duration, materializing
 *      each candidate's start/end as an *instant* in the host zone, then
 *      converting to UTC. Because we build the DateTime in the host zone,
 *      Luxon applies the correct UTC offset for that date — so a slot on either
 *      side of a daylight-saving transition lands on the right UTC instant,
 *      and the impossible hour during a spring-forward simply produces no slot.
 *
 * The result is a list of UTC instants. Capacity, holds and notice checks are
 * layered on top by the caller; this module only answers "when could a slot
 * start, given the host's schedule?".
 */

export interface WeeklyRule {
  /** 0 = Sunday ... 6 = Saturday (Luxon weekday is 1=Mon..7=Sun; we convert). */
  weekday: number;
  /** "HH:mm" or "HH:mm:ss" local wall-clock time in the host zone. */
  startTime: string;
  endTime: string;
}

export interface DateOverride {
  /** ISO date "YYYY-MM-DD" in the host zone. */
  overrideDate: string;
  isClosed: boolean;
  startTime: string | null;
  endTime: string | null;
}

export interface SlotGenParams {
  hostTimeZone: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  horizonDays: number;
  weeklyRules: WeeklyRule[];
  dateOverrides: DateOverride[];
  /** Range to generate within, as UTC instants (inclusive from, exclusive to). */
  fromUtc: DateTime;
  toUtc: DateTime;
  /** "Now" as a UTC instant; slots before now + minNotice are excluded. */
  nowUtc: DateTime;
}

export interface GeneratedSlot {
  /** Slot start as a UTC ISO string. */
  startUtc: string;
  /** Slot end as a UTC ISO string (start + duration). */
  endUtc: string;
}

/** Parse "HH:mm[:ss]" into {hour, minute}. */
function parseTime(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(":");
  return { hour: Number.parseInt(h, 10), minute: Number.parseInt(m, 10) };
}

/** Luxon weekday is 1=Mon..7=Sun; convert to JS 0=Sun..6=Sat. */
function luxonToJsWeekday(luxonWeekday: number): number {
  return luxonWeekday % 7;
}

/**
 * Generate candidate slot start instants from a schedule.
 *
 * The step between candidate starts is the duration plus the surrounding
 * buffers, so consecutive bookings never overlap once buffers are applied.
 * (A slot occupies [start, start+duration]; the next candidate starts after
 * bufferAfter + bufferBefore of gap.)
 */
export function generateSlots(params: SlotGenParams): GeneratedSlot[] {
  const {
    hostTimeZone,
    durationMin,
    bufferBeforeMin,
    bufferAfterMin,
    minNoticeMin,
    horizonDays,
    weeklyRules,
    dateOverrides,
    fromUtc,
    toUtc,
    nowUtc,
  } = params;

  // Earliest bookable instant: now + minimum notice.
  const earliest = nowUtc.plus({ minutes: minNoticeMin });
  // Latest bookable instant: now + horizon (in host-local days).
  const horizonEnd = nowUtc.setZone(hostTimeZone).plus({ days: horizonDays }).toUTC();

  // Effective range is the intersection of [from,to], [earliest, horizonEnd].
  const rangeStart = DateTime.max(fromUtc, earliest);
  const rangeEnd = DateTime.min(toUtc, horizonEnd);
  if (rangeStart >= rangeEnd) return [];

  // Index overrides by date for quick lookup.
  const overridesByDate = new Map<string, DateOverride>();
  for (const o of dateOverrides) overridesByDate.set(o.overrideDate, o);

  // Group weekly rules by JS weekday.
  const rulesByWeekday = new Map<number, WeeklyRule[]>();
  for (const r of weeklyRules) {
    const list = rulesByWeekday.get(r.weekday) ?? [];
    list.push(r);
    rulesByWeekday.set(r.weekday, list);
  }

  const step = durationMin + bufferBeforeMin + bufferAfterMin;
  const slots: GeneratedSlot[] = [];

  // Walk each day in the host zone, from the local day of rangeStart to rangeEnd.
  let day = rangeStart.setZone(hostTimeZone).startOf("day");
  const lastDay = rangeEnd.setZone(hostTimeZone).endOf("day");

  while (day <= lastDay) {
    const isoDate = day.toISODate(); // "YYYY-MM-DD" in host zone
    if (!isoDate) {
      day = day.plus({ days: 1 });
      continue;
    }

    // Determine the windows for this day.
    let windows: Array<{ startTime: string; endTime: string }> = [];
    const override = overridesByDate.get(isoDate);
    if (override) {
      if (override.isClosed) {
        windows = []; // day off — no slots
      } else if (override.startTime && override.endTime) {
        windows = [{ startTime: override.startTime, endTime: override.endTime }];
      }
    } else {
      const jsWeekday = luxonToJsWeekday(day.weekday);
      windows = (rulesByWeekday.get(jsWeekday) ?? []).map((r) => ({
        startTime: r.startTime,
        endTime: r.endTime,
      }));
    }

    for (const w of windows) {
      const { hour: sh, minute: sm } = parseTime(w.startTime);
      const { hour: eh, minute: em } = parseTime(w.endTime);

      // Build window bounds as instants in the host zone for THIS date, so the
      // correct DST offset is applied automatically.
      const windowStart = day.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
      const windowEnd = day.set({ hour: eh, minute: em, second: 0, millisecond: 0 });

      let cursor = windowStart;
      // Advance in local time so slot boundaries stay aligned to wall-clock
      // across a DST change within the window.
      while (true) {
        const slotEnd = cursor.plus({ minutes: durationMin });
        // The whole slot must fit inside the window.
        if (slotEnd > windowEnd) break;

        const startUtc = cursor.toUTC();
        const endUtc = slotEnd.toUTC();

        // Keep only slots inside the effective UTC range and notice/horizon.
        if (startUtc >= rangeStart && startUtc < rangeEnd && startUtc >= earliest) {
          slots.push({
            startUtc: startUtc.toISO({ suppressMilliseconds: true })!,
            endUtc: endUtc.toISO({ suppressMilliseconds: true })!,
          });
        }

        cursor = cursor.plus({ minutes: step });
        // Guard against a non-advancing cursor (step must be positive).
        if (step <= 0) break;
      }
    }

    day = day.plus({ days: 1 });
  }

  // De-duplicate and sort by start instant (overlapping windows/overrides).
  const seen = new Set<string>();
  const unique = slots.filter((s) => {
    if (seen.has(s.startUtc)) return false;
    seen.add(s.startUtc);
    return true;
  });
  unique.sort((a, b) => (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : 0));
  return unique;
}

/**
 * Validate that a specific requested start instant is a genuine slot for the
 * schedule. Used by the hold endpoint so clients can't hold arbitrary times.
 * Returns the matching slot (with its end) or null if invalid.
 */
export function validateSlot(
  startUtcIso: string,
  params: Omit<SlotGenParams, "fromUtc" | "toUtc">,
): GeneratedSlot | null {
  const start = DateTime.fromISO(startUtcIso, { zone: "utc" });
  if (!start.isValid) return null;

  // Generate within a tight window around the requested instant and look for
  // an exact match. A one-day pad on each side covers zone/day-boundary cases.
  const slots = generateSlots({
    ...params,
    fromUtc: start.minus({ days: 1 }),
    toUtc: start.plus({ days: 1 }),
  });

  const target = start.toISO({ suppressMilliseconds: true });
  return slots.find((s) => s.startUtc === target) ?? null;
}
