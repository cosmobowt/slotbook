-- Optional extension: per-guest limit.
-- A guest (by email, case-insensitive) may hold at most one active confirmed booking per event type.
-- Enforced by Postgres, like double-booking: two concurrent confirms for the same email cannot both commit.
-- Holds carry no email yet, so the limit applies at confirm, the first moment the guest is known.
CREATE UNIQUE INDEX one_active_booking_per_guest
  ON bookings (event_type_id, lower(guest_email))
  WHERE status = 'confirmed';
