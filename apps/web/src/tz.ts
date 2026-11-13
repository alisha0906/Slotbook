import { DateTime } from "luxon";

/** A curated list of common IANA zones for the switcher, plus the guest's own. */
export const COMMON_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

/** The guest's browser time zone. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Build a zone list that always includes the guest's own zone at the top. */
export function zoneOptions(): string[] {
  const own = browserZone();
  const set = new Set<string>([own, ...COMMON_ZONES]);
  return Array.from(set);
}

/** Format a UTC ISO instant as a time (e.g. "9:00 AM") in the given zone. */
export function formatTime(utcIso: string, zone: string): string {
  return DateTime.fromISO(utcIso, { zone: "utc" })
    .setZone(zone)
    .toLocaleString(DateTime.TIME_SIMPLE);
}

/** Format a UTC ISO instant as a full date+time in the given zone. */
export function formatDateTime(utcIso: string, zone: string): string {
  return DateTime.fromISO(utcIso, { zone: "utc" })
    .setZone(zone)
    .toLocaleString(DateTime.DATETIME_MED);
}

/** The local date label for grouping (e.g. "Wed, Nov 12") in the given zone. */
export function dayLabel(utcIso: string, zone: string): string {
  return DateTime.fromISO(utcIso, { zone: "utc" })
    .setZone(zone)
    .toLocaleString({ weekday: "short", month: "short", day: "numeric" });
}

/** Group slots by their local calendar day in the given zone. */
export function groupByDay<T extends { startUtc: string }>(
  slots: T[],
  zone: string,
): Array<{ label: string; slots: T[] }> {
  const groups = new Map<string, { label: string; slots: T[] }>();
  for (const s of slots) {
    const key = DateTime.fromISO(s.startUtc, { zone: "utc" }).setZone(zone).toISODate() ?? s.startUtc;
    if (!groups.has(key)) groups.set(key, { label: dayLabel(s.startUtc, zone), slots: [] });
    groups.get(key)!.slots.push(s);
  }
  return Array.from(groups.values());
}
