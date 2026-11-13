-- Slotbook initial schema
-- All instants are stored as timestamptz (UTC). Availability windows are stored
-- as local wall-clock time + the host's IANA time zone.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enums ----------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE booking_status AS ENUM ('held', 'confirmed', 'cancelled', 'expired');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE notification_type AS ENUM ('booking_confirmed', 'booking_rescheduled', 'booking_cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Hosts ----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hosts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  timezone      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Event types ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS event_types (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id           uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  name              text NOT NULL,
  slug              text NOT NULL,
  duration_min      integer NOT NULL,
  capacity          integer NOT NULL DEFAULT 1,
  buffer_before_min integer NOT NULL DEFAULT 0,
  buffer_after_min  integer NOT NULL DEFAULT 0,
  min_notice_min    integer NOT NULL DEFAULT 0,
  horizon_days      integer NOT NULL DEFAULT 30,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_types_duration_ck CHECK (duration_min BETWEEN 15 AND 120),
  CONSTRAINT event_types_capacity_ck CHECK (capacity >= 1),
  CONSTRAINT event_types_buffer_before_ck CHECK (buffer_before_min BETWEEN 0 AND 30),
  CONSTRAINT event_types_buffer_after_ck CHECK (buffer_after_min BETWEEN 0 AND 30),
  CONSTRAINT event_types_min_notice_ck CHECK (min_notice_min >= 0),
  CONSTRAINT event_types_horizon_ck CHECK (horizon_days >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_types_host_slug_unique
  ON event_types (host_id, slug);

-- Weekly availability --------------------------------------------------------

CREATE TABLE IF NOT EXISTS availability_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type_id uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  weekday       smallint NOT NULL,
  start_time    time NOT NULL,
  end_time      time NOT NULL,
  CONSTRAINT availability_weekday_ck CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT availability_window_ck CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS availability_rules_event_idx
  ON availability_rules (event_type_id);

-- Date overrides -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS date_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type_id uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  override_date date NOT NULL,
  is_closed     boolean NOT NULL DEFAULT false,
  start_time    time,
  end_time      time,
  CONSTRAINT date_overrides_window_ck
    CHECK (is_closed OR (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time))
);

CREATE INDEX IF NOT EXISTS date_overrides_event_date_idx
  ON date_overrides (event_type_id, override_date);

-- Bookings -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type_id   uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  slot_start      timestamptz NOT NULL,
  slot_end        timestamptz NOT NULL,
  status          booking_status NOT NULL DEFAULT 'held',
  hold_expires_at timestamptz,
  guest_name      text,
  guest_email     text,
  manage_token    uuid NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key text,
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_manage_token_unique
  ON bookings (manage_token);

-- Idempotency: the same key retried on the same event type maps to one hold.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_idempotency_unique
  ON bookings (event_type_id, idempotency_key);

-- Capacity lookups: count active rows for a slot.
CREATE INDEX IF NOT EXISTS bookings_slot_idx
  ON bookings (event_type_id, slot_start, status);

-- Notifications sink ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  type       notification_type NOT NULL,
  payload    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
