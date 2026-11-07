import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmt, ZONES } from './api';

interface Me { username: string; displayName: string; timezone: string }
interface EventType {
  id: string; name: string; slug: string; durationMin: number; capacity: number;
  bufferBeforeMin: number; bufferAfterMin: number; minNoticeMin: number; horizonDays: number; active: boolean;
}
interface Window { weekday?: number; date?: string; start: string | null; end: string | null }
interface HostBooking { id: string; start: string; end: string; guestName: string; guestEmail: string; eventName: string }
interface Notification { id: number; type: string; createdAt: string; payload: { start: string; guestEmail: string } }

const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function Login({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function submit(form: FormData) {
    try {
      const { token } = await api<{ token: string }>('/api/host/login', {
        method: 'POST',
        json: { username: form.get('username'), password: form.get('password') },
      });
      localStorage.setItem('slotbook.hostToken', token);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main>
      <h1>Host login</h1>
      {error && <p className="error">{error}</p>}
      <form action={submit}>
        <label>Username <input name="username" defaultValue="demo" /></label>
        <label>Password <input name="password" type="password" defaultValue="demo1234" /></label>
        <button type="submit">Log in</button>
      </form>
    </main>
  );
}

/** Availability editor: one line per window, e.g. "Mon 09:00-13:00" or "2026-12-25 off". */
function AvailabilityEditor({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api<{ rules: Window[]; overrides: Window[] }>('/api/host/availability').then((a) =>
      setText(
        [
          ...a.rules.map((r) => `${DAYS[r.weekday!]} ${r.start}-${r.end}`),
          ...a.overrides.map((o) => (o.start ? `${o.date} ${o.start}-${o.end}` : `${o.date} off`)),
        ].join('\n'),
      ),
    );
  }, []);
  async function save() {
    const rules: Window[] = [];
    const overrides: Window[] = [];
    for (const raw of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const m = raw.match(/^(\S+)\s+(?:(off)|(\d\d:\d\d)-(\d\d:\d\d))$/i);
      if (!m) return setMsg(`Can't read line: "${raw}"`);
      const [, when, off, start, end] = m;
      const day = DAYS.indexOf(when.slice(0, 3));
      if (/^\d{4}-\d{2}-\d{2}$/.test(when)) overrides.push({ date: when, start: off ? null : start, end: off ? null : end });
      else if (day > 0 && !off) rules.push({ weekday: day, start, end });
      else return setMsg(`Can't read line: "${raw}"`);
    }
    try {
      await api('/api/host/availability', { method: 'PUT', json: { rules, overrides } });
      setMsg('Saved');
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <section className="card">
      <h2>Weekly availability and date overrides</h2>
      <p className="muted">One window per line, in your home time zone. Examples: <code>Mon 09:00-13:00</code>, <code>2026-12-25 off</code>, <code>2026-12-24 10:00-12:00</code>. A date line replaces that day's weekly hours.</p>
      <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} aria-label="Availability" />
      <button onClick={save}>Save availability</button> {msg && <span className="muted">{msg}</span>}
    </section>
  );
}

function EventTypeForm({ onSaved }: { onSaved: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  async function submit(f: FormData) {
    const n = (k: string) => Number(f.get(k));
    try {
      await api('/api/host/event-types', {
        method: 'POST',
        json: {
          name: f.get('name'), slug: f.get('slug'), durationMin: n('durationMin'), capacity: n('capacity'),
          bufferBeforeMin: n('bufferBeforeMin'), bufferAfterMin: n('bufferAfterMin'),
          minNoticeMin: n('minNoticeHours') * 60, horizonDays: n('horizonDays'),
        },
      });
      setMsg('Created');
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <form action={submit} className="grid">
      <label>Name <input name="name" required /></label>
      <label>Slug <input name="slug" required pattern="[a-z0-9-]{2,60}" /></label>
      <label>Duration (min) <input name="durationMin" type="number" min={15} max={120} defaultValue={30} /></label>
      <label>Capacity <input name="capacity" type="number" min={1} defaultValue={1} /></label>
      <label>Buffer before <input name="bufferBeforeMin" type="number" min={0} max={30} defaultValue={0} /></label>
      <label>Buffer after <input name="bufferAfterMin" type="number" min={0} max={30} defaultValue={0} /></label>
      <label>Min notice (h) <input name="minNoticeHours" type="number" min={0} defaultValue={4} /></label>
      <label>Horizon (days) <input name="horizonDays" type="number" min={1} max={365} defaultValue={30} /></label>
      <button type="submit">Create event type</button> {msg && <span className="muted">{msg}</span>}
    </form>
  );
}

export function HostDashboard() {
  const [me, setMe] = useState<Me | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [types, setTypes] = useState<EventType[]>([]);
  const [bookings, setBookings] = useState<HostBooking[]>([]);
  const [notes, setNotes] = useState<Notification[]>([]);

  const load = useCallback(async () => {
    try {
      const m = await api<Me>('/api/host/me');
      setMe(m);
      setNeedsLogin(false);
      const [t, b, n] = await Promise.all([
        api<EventType[]>('/api/host/event-types'),
        api<HostBooking[]>('/api/host/bookings'),
        api<Notification[]>('/api/host/notifications'),
      ]);
      setTypes(t);
      setBookings(b);
      setNotes(n);
    } catch {
      setNeedsLogin(true);
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (needsLogin) return <Login onDone={load} />;
  if (!me) return <main><p>Loading…</p></main>;

  async function setZone(timezone: string) {
    await api('/api/host/me', { method: 'PATCH', json: { timezone } });
    load();
  }
  async function cancel(id: string) {
    const reason = prompt('Reason for cancelling (sent to the guest)');
    if (!reason) return;
    await api(`/api/host/bookings/${id}/cancel`, { method: 'POST', json: { reason } });
    load();
  }

  return (
    <main className="wide">
      <p><Link to="/">← Slotbook</Link> · <button onClick={() => { localStorage.removeItem('slotbook.hostToken'); setNeedsLogin(true); }}>Log out</button></p>
      <h1>{me.displayName}</h1>
      <label>
        Home time zone{' '}
        <select value={me.timezone} onChange={(e) => setZone(e.target.value)}>
          {(ZONES.includes(me.timezone) ? ZONES : [me.timezone, ...ZONES]).map((z) => <option key={z}>{z}</option>)}
        </select>
      </label>

      <section className="card">
        <h2>Upcoming bookings</h2>
        {bookings.length === 0 && <p className="muted">None yet.</p>}
        <table>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id}>
                <td>{fmt(b.start, me.timezone)}</td>
                <td>{b.eventName}</td>
                <td>{b.guestName} &lt;{b.guestEmail}&gt;</td>
                <td><button onClick={() => cancel(b.id)}>Cancel</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Event types</h2>
        <ul>
          {types.map((t) => (
            <li key={t.id}>
              <Link to={`/${me.username}/${t.slug}`}>{t.name}</Link> — {t.durationMin} min, capacity {t.capacity},
              buffers {t.bufferBeforeMin}/{t.bufferAfterMin} min, notice {t.minNoticeMin / 60} h, horizon {t.horizonDays} days
            </li>
          ))}
        </ul>
        <EventTypeForm onSaved={load} />
      </section>

      <AvailabilityEditor onSaved={load} />

      <section className="card">
        <h2>Notifications sink</h2>
        <p className="muted">Written in the same transaction as each change (outbox), so an event exists if and only if the change committed.</p>
        <ul>
          {notes.map((n) => (
            <li key={n.id}><code>{n.type}</code> · {n.payload.guestEmail} · {fmt(n.payload.start, me.timezone)} · <span className="muted">{fmt(n.createdAt, me.timezone)}</span></li>
          ))}
        </ul>
      </section>
    </main>
  );
}
