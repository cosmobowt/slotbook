import { useEffect, useState } from 'react';
import { api, browserZone, ZONES, type Slot, type SlotsResponse } from './api';

/** Lists slots grouped by the guest's local date, with a time-zone switcher. */
export function SlotPicker(props: {
  host: string;
  slug: string;
  onPick: (slot: Slot, tz: string) => void;
  disabled?: boolean;
  refreshKey?: number;
  onLoaded?: (r: SlotsResponse) => void;
}) {
  const [tz, setTz] = useState(browserZone());
  const [data, setData] = useState<SlotsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api<SlotsResponse>(`/api/hosts/${props.host}/events/${props.slug}/slots?tz=${encodeURIComponent(tz)}`)
      .then((r) => {
        setData(r);
        props.onLoaded?.(r);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.host, props.slug, tz, props.refreshKey]);

  const byDate = new Map<string, Slot[]>();
  for (const s of data?.slots ?? []) byDate.set(s.localDate, [...(byDate.get(s.localDate) ?? []), s]);
  const zones = ZONES.includes(tz) ? ZONES : [tz, ...ZONES];

  return (
    <section>
      <label>
        Show times in{' '}
        <select value={tz} onChange={(e) => setTz(e.target.value)} aria-label="Time zone">
          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      {data && data.slots.length === 0 && <p>No available times in the next {30} days.</p>}
      {[...byDate.entries()].map(([date, slots]) => (
        <div key={date} className="day">
          <h3>{new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))}</h3>
          <div className="slots">
            {slots.map((s) => (
              <button key={s.start} disabled={props.disabled} onClick={() => props.onPick(s, tz)}>
                {s.localTime}
                {data!.eventType.capacity > 1 && <small> · {s.seatsLeft} left</small>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
