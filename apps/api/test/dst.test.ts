import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { candidateStarts, wallClockToInstant, type EventTypeConfig } from '../src/engine/slots.js';

const ev: EventTypeConfig = {
  id: 'e1',
  durationMin: 30,
  capacity: 1,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 0,
  horizonDays: 365,
};
const now = new Date('2026-01-01T00:00:00Z');
const NY = 'America/New_York';
const ist = (d: Date) => DateTime.fromJSDate(d, { zone: 'Asia/Kolkata' }).toFormat('ccc dd LLL HH:mm');

describe('time zones: slots generated in host zone, shown in guest zone', () => {
  it('worked example: US DST ends Sun 1 Nov 2026 — 09:00 New York host, guest in India', () => {
    const rules = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '10:00' }));
    const slots = candidateStarts({
      eventType: ev,
      hostZone: NY,
      rules,
      overrides: [],
      now,
      from: new Date('2026-10-30T00:00:00Z'),
      to: new Date('2026-11-03T00:00:00Z'),
    });
    const fri = slots.find((s) => s.start.toISOString().startsWith('2026-10-30'))!;
    const mon = slots.find((s) => s.start.toISOString().startsWith('2026-11-02'))!;

    // Host wall clock: 09:00 both days. UTC moves by an hour because the offset changed (EDT -4 -> EST -5).
    expect(fri.start.toISOString()).toBe('2026-10-30T13:00:00.000Z');
    expect(mon.start.toISOString()).toBe('2026-11-02T14:00:00.000Z');
    // The guest in India (no DST) correctly sees the slot move from 18:30 to 19:30.
    expect(ist(fri.start)).toBe('Fri 30 Oct 18:30');
    expect(ist(mon.start)).toBe('Mon 02 Nov 19:30');
  });

  it('spring-forward gap: a window 02:30–05:00 on 8 Mar 2026 starts at 03:00 local, the first real minute', () => {
    expect(wallClockToInstant('2026-03-08', '02:30', NY).toISO()).toBe('2026-03-08T03:00:00.000-04:00');
    const slots = candidateStarts({
      eventType: ev,
      hostZone: NY,
      rules: [],
      overrides: [{ date: '2026-03-08', start: '02:30', end: '05:00' }],
      now,
      from: new Date('2026-03-08T00:00:00Z'),
      to: new Date('2026-03-09T00:00:00Z'),
    });
    // 03:00–05:00 EDT is 2 real hours -> 4 half-hour slots, none in the hour that does not exist.
    expect(slots.map((s) => DateTime.fromJSDate(s.start, { zone: NY }).toFormat('HH:mm'))).toEqual(['03:00', '03:30', '04:00', '04:30']);
  });

  it('fall-back overlap: 00:00–04:00 on 1 Nov 2026 is 5 real hours; 01:30 resolves to the earlier one', () => {
    // Ambiguous wall time policy is pinned by this assertion: earlier occurrence (EDT, -04:00).
    expect(wallClockToInstant('2026-11-01', '01:30', NY).toISO()).toBe('2026-11-01T01:30:00.000-04:00');
    const slots = candidateStarts({
      eventType: ev,
      hostZone: NY,
      rules: [],
      overrides: [{ date: '2026-11-01', start: '00:00', end: '04:00' }],
      now,
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-02T00:00:00Z'),
    });
    expect(slots).toHaveLength(10); // 5 real hours, stepped in absolute minutes
    const utc = slots.map((s) => s.start.toISOString().slice(11, 16));
    expect(new Set(utc).size).toBe(10); // no duplicate instants even though 01:xx repeats on the wall
  });

  it('date overrides replace the weekly rule; a NULL override is a day off', () => {
    const rules = [{ weekday: 2, start: '09:00', end: '10:00' }]; // Tuesdays
    const run = (overrides: { date: string; start: string | null; end: string | null }[]) =>
      candidateStarts({
        eventType: ev, hostZone: 'Asia/Kolkata', rules, overrides, now,
        from: new Date('2026-12-01T00:00:00+05:30'), to: new Date('2026-12-02T00:00:00+05:30'),
      }).map((s) => DateTime.fromJSDate(s.start, { zone: 'Asia/Kolkata' }).toFormat('HH:mm'));
    expect(run([])).toEqual(['09:00', '09:30']);
    expect(run([{ date: '2026-12-01', start: null, end: null }])).toEqual([]);
    expect(run([{ date: '2026-12-01', start: '15:00', end: '16:00' }])).toEqual(['15:00', '15:30']);
  });

  it('minimum notice and horizon are measured from the supplied (database) now', () => {
    const dbNow = new Date('2026-12-01T03:00:00Z'); // 08:30 IST
    const slots = candidateStarts({
      eventType: { ...ev, minNoticeMin: 120, horizonDays: 1 },
      hostZone: 'Asia/Kolkata',
      rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '12:00' })),
      overrides: [],
      now: dbNow,
      from: dbNow,
      to: new Date('2026-12-10T00:00:00Z'),
    });
    const local = slots.map((s) => DateTime.fromJSDate(s.start, { zone: 'Asia/Kolkata' }).toFormat('dd HH:mm'));
    expect(local[0]).toBe('01 10:30'); // 08:30 + 2h notice
    expect(local.at(-1)).toBe('01 11:30'); // horizon: nothing after now + 1 day (02 08:30 IST)
  });
});
