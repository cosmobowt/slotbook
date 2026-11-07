-- Slotbook schema.
-- Design rule: the application never decides whether a slot is free. Postgres does,
-- through constraints that hold no matter how many API instances race each other.

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- lets GiST mix "=" / "<>" on uuid with "&&" on ranges
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()

-- ─── Hosts ──────────────────────────────────────────────────────────────────
CREATE TABLE hosts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9-]{2,40}$'),
  display_name  text NOT NULL,
  timezone      text NOT NULL,                -- IANA name, validated in the API (Luxon) on write
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE host_sessions (
  token       text PRIMARY KEY,
  host_id     uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);

-- ─── Event types ────────────────────────────────────────────────────────────
CREATE TABLE event_types (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id            uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  slug               text NOT NULL CHECK (slug ~ '^[a-z0-9-]{2,60}$'),
  name               text NOT NULL,
  duration_min       int  NOT NULL CHECK (duration_min BETWEEN 15 AND 120),
  capacity           int  NOT NULL CHECK (capacity >= 1),
  buffer_before_min  int  NOT NULL DEFAULT 0 CHECK (buffer_before_min BETWEEN 0 AND 30),
  buffer_after_min   int  NOT NULL DEFAULT 0 CHECK (buffer_after_min  BETWEEN 0 AND 30),
  min_notice_min     int  NOT NULL DEFAULT 240 CHECK (min_notice_min >= 0),
  horizon_days       int  NOT NULL DEFAULT 30  CHECK (horizon_days BETWEEN 1 AND 365),
  active             boolean NOT NULL DEFAULT true,
  UNIQUE (host_id, slug)
);

-- ─── Availability (wall-clock times in the HOST's time zone) ───────────────
CREATE TABLE availability_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id     uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  weekday     int  NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1 = Monday
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  CHECK (start_time < end_time)
);

-- If any override row exists for a date, it replaces the weekly rules for that date.
-- A row with NULL times means "day off".
CREATE TABLE date_overrides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id     uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  on_date     date NOT NULL,
  start_time  time,
  end_time    time,
  CHECK ((start_time IS NULL AND end_time IS NULL) OR (start_time < end_time))
);
CREATE INDEX ON date_overrides (host_id, on_date);

-- ─── Slot sessions ──────────────────────────────────────────────────────────
-- One row per (event type, start instant) that anyone has ever tried to book.
-- It is (a) the identity of a group session, used by the exclusion constraint below,
-- and (b) the row we lock with SELECT ... FOR UPDATE to count seats safely.
CREATE TABLE slot_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type_id uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  start_at      timestamptz NOT NULL,
  UNIQUE (event_type_id, start_at)
);

-- ─── Bookings ───────────────────────────────────────────────────────────────
CREATE TYPE booking_status AS ENUM ('held', 'confirmed', 'cancelled', 'expired');

CREATE TABLE bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id          uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  event_type_id    uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  session_id       uuid NOT NULL REFERENCES slot_sessions(id),
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  -- The time the HOST is unavailable: [start - buffer_before, end + buffer_after)
  blocked          tstzrange NOT NULL,
  status           booking_status NOT NULL DEFAULT 'held',
  hold_expires_at  timestamptz,                         -- set from the DB clock, never the app's
  guest_name       text,
  guest_email      text,
  manage_token     text UNIQUE,                          -- private link, issued on confirm
  cancel_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,
  cancelled_at     timestamptz,
  CHECK (start_at < end_at),
  CHECK (blocked @> tstzrange(start_at, end_at, '[)')),
  CHECK (status <> 'held'      OR hold_expires_at IS NOT NULL),
  CHECK (status <> 'confirmed' OR (guest_email IS NOT NULL AND manage_token IS NOT NULL)),

  -- THE double-booking guarantee.
  -- Two active rows for the same host may not have overlapping blocked ranges,
  -- unless they are seats in the very same session (same event type + same start).
  -- Seats within one session are then capped by the FOR UPDATE count in the engine.
  CONSTRAINT no_double_booking EXCLUDE USING gist (
    host_id    WITH =,
    blocked    WITH &&,
    session_id WITH <>
  ) WHERE (status IN ('held', 'confirmed'))
);
CREATE INDEX bookings_host_upcoming ON bookings (host_id, start_at) WHERE status IN ('held', 'confirmed');
CREATE INDEX bookings_session_active ON bookings (session_id) WHERE status IN ('held', 'confirmed');
CREATE INDEX bookings_held_expiry ON bookings (hold_expires_at) WHERE status = 'held';

-- ─── Idempotency keys (POST /api/holds) ────────────────────────────────────
-- Claimed in the SAME transaction as the hold: the key and the hold commit together or not at all.
CREATE TABLE idempotency_keys (
  scope            text NOT NULL,
  key              text NOT NULL,
  request_hash     text NOT NULL,
  response_status  int  NOT NULL,
  response_body    jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- ─── Notifications sink (transactional outbox) ─────────────────────────────
CREATE TABLE notifications (
  id           bigserial PRIMARY KEY,
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('booking.confirmed', 'booking.rescheduled', 'booking.cancelled')),
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
