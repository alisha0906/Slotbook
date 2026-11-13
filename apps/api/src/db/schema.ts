import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  timestamp,
  time,
  date,
  boolean,
  smallint,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Slotbook data model.
 *
 * Design principles:
 * - All instants (slot start/end, hold expiry, timestamps) are stored in UTC
 *   (`timestamptz`). Wall-clock availability is stored as local time + the host
 *   time zone, and converted to UTC instants at slot-generation time.
 * - Booking correctness lives in the database: capacity is enforced inside a
 *   transaction, and expired/cancelled rows never count against capacity.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Booking lifecycle: held -> confirmed -> (optionally) cancelled.
 * A hold that is not confirmed before its expiry becomes `expired`.
 * Only `held` (not yet expired) and `confirmed` rows consume capacity.
 */
export const bookingStatus = pgEnum("booking_status", [
  "held",
  "confirmed",
  "cancelled",
  "expired",
]);

/** Notification event kinds emitted to the notifications sink. */
export const notificationType = pgEnum("notification_type", [
  "booking_confirmed",
  "booking_rescheduled",
  "booking_cancelled",
]);

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export const hosts = pgTable("hosts", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  email: text("email").notNull().unique(),
  // Simple seeded credential for the host login. A real app would hash this;
  // for the take-home a seeded login is explicitly allowed.
  passwordHash: text("password_hash").notNull(),
  // IANA time zone, e.g. "Asia/Kolkata", "America/New_York".
  timezone: text("timezone").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export const eventTypes = pgTable(
  "event_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hostId: uuid("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // Duration in minutes (15-120, validated at the API layer).
    durationMin: integer("duration_min").notNull(),
    // Capacity: 1 = one-on-one, >1 = group session.
    capacity: integer("capacity").notNull().default(1),
    // Buffers around a booking, in minutes (0-30).
    bufferBeforeMin: integer("buffer_before_min").notNull().default(0),
    bufferAfterMin: integer("buffer_after_min").notNull().default(0),
    // Minimum notice before a slot can be booked, in minutes (e.g. 240 = 4h).
    minNoticeMin: integer("min_notice_min").notNull().default(0),
    // How far ahead bookings are allowed, in days (e.g. 30).
    horizonDays: integer("horizon_days").notNull().default(30),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // A slug is unique per host so /{host}/{event-slug} resolves unambiguously.
    hostSlugUnique: uniqueIndex("event_types_host_slug_unique").on(t.hostId, t.slug),
  }),
);

// ---------------------------------------------------------------------------
// Weekly availability (recurring windows in the host's time zone)
// ---------------------------------------------------------------------------

export const availabilityRules = pgTable(
  "availability_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventTypeId: uuid("event_type_id")
      .notNull()
      .references(() => eventTypes.id, { onDelete: "cascade" }),
    // 0 = Sunday ... 6 = Saturday (JS getDay convention).
    weekday: smallint("weekday").notNull(),
    // Local wall-clock window in the host's time zone, e.g. 09:00 - 17:00.
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
  },
  (t) => ({
    byEvent: index("availability_rules_event_idx").on(t.eventTypeId),
  }),
);

// ---------------------------------------------------------------------------
// Date overrides (a day off, or custom hours for one date)
// ---------------------------------------------------------------------------

export const dateOverrides = pgTable(
  "date_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventTypeId: uuid("event_type_id")
      .notNull()
      .references(() => eventTypes.id, { onDelete: "cascade" }),
    // The calendar date in the host's time zone this override applies to.
    overrideDate: date("override_date").notNull(),
    // When true, the host is unavailable all day (overrides weekly rules).
    isClosed: boolean("is_closed").notNull().default(false),
    // Custom window for the date (used when isClosed = false). Both null +
    // isClosed=false is invalid and rejected at the API layer.
    startTime: time("start_time"),
    endTime: time("end_time"),
  },
  (t) => ({
    byEventDate: index("date_overrides_event_date_idx").on(t.eventTypeId, t.overrideDate),
  }),
);

// ---------------------------------------------------------------------------
// Bookings (holds + confirmed + cancelled + expired)
// ---------------------------------------------------------------------------

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventTypeId: uuid("event_type_id")
      .notNull()
      .references(() => eventTypes.id, { onDelete: "cascade" }),

    // The booked slot, stored as UTC instants. slotStart identifies the slot;
    // capacity is counted per (eventTypeId, slotStart).
    slotStart: timestamp("slot_start", { withTimezone: true }).notNull(),
    slotEnd: timestamp("slot_end", { withTimezone: true }).notNull(),

    status: bookingStatus("status").notNull().default("held"),

    // When a held row expires. For confirmed/cancelled rows this is null.
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),

    // Guest details (collected at confirm; null while only held, though a hold
    // may pre-fill them). Email is used for the per-guest limit extension.
    guestName: text("guest_name"),
    guestEmail: text("guest_email"),

    // Private token for the guest manage link (view/reschedule/cancel).
    manageToken: uuid("manage_token").defaultRandom().notNull(),

    // Idempotency key supplied on POST /api/holds so a retried request returns
    // the same hold instead of creating a duplicate.
    idempotencyKey: text("idempotency_key"),

    cancelReason: text("cancel_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    manageTokenUnique: uniqueIndex("bookings_manage_token_unique").on(t.manageToken),
    // Idempotency keys are unique per event type so the same key retried maps
    // to one hold. (Null keys are allowed and not deduplicated.)
    idempotencyUnique: unique("bookings_idempotency_unique").on(
      t.eventTypeId,
      t.idempotencyKey,
    ),
    // Fast capacity lookups: count active rows for a given slot.
    slotLookup: index("bookings_slot_idx").on(t.eventTypeId, t.slotStart, t.status),
  }),
);

// ---------------------------------------------------------------------------
// Notifications sink
// ---------------------------------------------------------------------------

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
  type: notificationType("type").notNull(),
  // Full event payload as JSON text (recipient, slot, event type, etc.).
  payload: text("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
