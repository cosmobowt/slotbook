import { DateTime, IANAZone } from 'luxon';

/**
 * Slot generation. Pure functions: no I/O and no Date.now(). The caller passes `now`,
 * which always comes from Postgres (SELECT now()), so the whole system has one clock.
 *
 * Rule: availability is wall-clock time in the HOST's zone. We walk the host's local
 * calendar dates and convert each wall-clock window to absolute instants for THAT date.
 * We never add 24h to a UTC timestamp — that drifts by an hour across a DST change.
 */

export interface EventTypeConfig {
  id: string;
  durationMin: number;
  capacity: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  horizonDays: number;
}

export interface WeeklyRule {
  weekday: number; // ISO 1 = Monday … 7 = Sunday
  start: string; // 'HH:MM' or 'HH:MM:SS', host wall-clock
  end: string;
}

export interface DateOverride {
  date: string; // 'YYYY-MM-DD' in host zone
  start: string | null; // null = day off
  end: string | null;
}

/** An active (held or confirmed) booking of the same host, from any event type. */
export interface BusyBlock {
  eventTypeId: string;
  start: Date; // session start (used to recognise "same session")
  blockedStart: Date;
  blockedEnd: Date;
}

export interface Slot {
  start: Date;
  end: Date;
  seatsLeft: number;
}

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

/**
 * Convert a host wall-clock time on a host calendar date to an instant.
 * Nonexistent times (spring-forward gap) are moved forward to the first valid
 * instant — a window "02:30–05:00" on gap day starts at 03:00 local. Ambiguous
 * times (fall-back overlap) resolve to the EARLIER occurrence, like RFC 5545 (iCalendar).
 * That is an explicit choice: Luxon's own default picks the later one, which the
 * test in test/dst.test.ts caught. The policy is pinned by that test.
 */
export function wallClockToInstant(date: string, time: string, zone: string): DateTime {
  const hhmm = time.slice(0, 5);
  const dt = DateTime.fromISO(`${date}T${hhmm}`, { zone });
  if (!dt.isValid) throw new Error(`Invalid wall-clock time ${date} ${time} in ${zone}: ${dt.invalidExplanation}`);
  if (dt.toFormat('HH:mm') !== hhmm && dt.toISODate() === date) {
    // Fell into a DST gap; Luxon shifted it by the gap size. Snap to the transition instant instead,
    // i.e. the first minute that exists after the requested time.
    const before = DateTime.fromISO(`${date}T00:00`, { zone });
    let probe = dt.minus({ minutes: 1 });
    while (probe > before && probe.toFormat('HH:mm') >= hhmm) probe = probe.minus({ minutes: 1 });
    return probe.plus({ minutes: 1 });
  }
  // Fall-back overlap: the same wall time exists twice. Take the earlier instant.
  const options = dt.getPossibleOffsets();
  if (options.length > 1) return options.reduce((a, b) => (a.toMillis() <= b.toMillis() ? a : b));
  return dt;
}

function windowsFor(
  localDate: DateTime,
  rules: WeeklyRule[],
  overrides: DateOverride[],
): { start: string; end: string }[] {
  const iso = localDate.toISODate()!;
  const todays = overrides.filter((o) => o.date === iso);
  if (todays.length > 0) {
    return todays.filter((o) => o.start && o.end).map((o) => ({ start: o.start!, end: o.end! }));
  }
  return rules.filter((r) => r.weekday === localDate.weekday).map((r) => ({ start: r.start, end: r.end }));
}

/**
 * All starts the host's rules allow in [from, to), respecting minimum notice and
 * booking horizon relative to `now`. Ignores existing bookings.
 */
export function candidateStarts(args: {
  eventType: EventTypeConfig;
  hostZone: string;
  rules: WeeklyRule[];
  overrides: DateOverride[];
  now: Date;
  from: Date;
  to: Date;
}): { start: Date; end: Date }[] {
  const { eventType, hostZone, rules, overrides, now, from, to } = args;
  const nowMs = now.getTime();
  const earliest = Math.max(from.getTime(), nowMs + eventType.minNoticeMin * 60_000);
  const latest = Math.min(to.getTime(), nowMs + eventType.horizonDays * 86_400_000);
  if (earliest >= latest) return [];

  const out: { start: Date; end: Date }[] = [];
  // Walk host-local calendar days. Start a day early so windows that begin "yesterday" in
  // the host zone but land inside [from, to) for the guest are still included.
  let day = DateTime.fromMillis(earliest, { zone: hostZone }).startOf('day').minus({ days: 1 });
  const lastDay = DateTime.fromMillis(latest, { zone: hostZone }).startOf('day').plus({ days: 1 });

  while (day <= lastDay) {
    const date = day.toISODate()!;
    for (const w of windowsFor(day, rules, overrides)) {
      const windowStart = wallClockToInstant(date, w.start, hostZone);
      const windowEnd = wallClockToInstant(date, w.end, hostZone);
      // Step in absolute minutes from the window start: a window that spans a DST change
      // gets the real number of hours, not the number on the clock face.
      for (let s = windowStart; s.plus({ minutes: eventType.durationMin }) <= windowEnd; s = s.plus({ minutes: eventType.durationMin })) {
        const ms = s.toMillis();
        if (ms >= earliest && ms < latest) {
          out.push({ start: s.toJSDate(), end: s.plus({ minutes: eventType.durationMin }).toJSDate() });
        }
      }
    }
    day = day.plus({ days: 1 }); // calendar-day arithmetic in the host zone, DST-safe
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function blockedRange(eventType: EventTypeConfig, start: Date, end: Date): { start: Date; end: Date } {
  return {
    start: new Date(start.getTime() - eventType.bufferBeforeMin * 60_000),
    end: new Date(end.getTime() + eventType.bufferAfterMin * 60_000),
  };
}

/**
 * Candidate starts minus those blocked by existing bookings. This is a *display* filter:
 * correctness does not depend on it. A stale page can still offer a taken slot — the
 * database constraint rejects the hold, and the guest sees "no longer available".
 */
export function availableSlots(args: Parameters<typeof candidateStarts>[0] & { busy: BusyBlock[] }): Slot[] {
  const { eventType, busy } = args;
  const result: Slot[] = [];
  for (const c of candidateStarts(args)) {
    const blocked = blockedRange(eventType, c.start, c.end);
    let seatsTaken = 0;
    let conflict = false;
    for (const b of busy) {
      const overlaps = b.blockedStart < blocked.end && blocked.start < b.blockedEnd;
      if (!overlaps) continue;
      const sameSession = b.eventTypeId === eventType.id && b.start.getTime() === c.start.getTime();
      if (sameSession) seatsTaken++;
      else {
        conflict = true;
        break;
      }
    }
    const seatsLeft = eventType.capacity - seatsTaken;
    if (!conflict && seatsLeft > 0) result.push({ start: c.start, end: c.end, seatsLeft });
  }
  return result;
}
