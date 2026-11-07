import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmt, type Booking, type Slot, type SlotsResponse } from './api';
import { SlotPicker } from './SlotPicker';

interface Hold {
  holdId: string;
  start: string;
  end: string;
  expiresAt: string;
}

export function BookingPage() {
  const { host = '', slug = '' } = useParams();
  const [info, setInfo] = useState<SlotsResponse['eventType'] | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [tz, setTz] = useState('UTC');
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Countdown is display only. The server decides expiry using the database clock.
  useEffect(() => {
    if (!hold) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.round((Date.parse(hold.expiresAt) - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [hold]);

  async function pick(slot: Slot, zone: string) {
    setError(null);
    setBusy(true);
    setTz(zone);
    try {
      // One key per user intent: a retried or double-clicked request maps to the same hold.
      const key = crypto.randomUUID();
      const h = await api<Hold>('/api/holds', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        json: { host, slug, start: slot.start },
      });
      setHold(h);
    } catch (e) {
      setError((e as Error).message);
      setRefresh((r) => r + 1);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(form: FormData) {
    if (!hold) return;
    setError(null);
    setBusy(true);
    try {
      const b = await api<Booking>(`/api/holds/${hold.holdId}/confirm`, {
        method: 'POST',
        json: { name: form.get('name'), email: form.get('email') },
      });
      setBooking(b);
    } catch (e) {
      setError((e as Error).message);
      setHold(null);
      setRefresh((r) => r + 1);
    } finally {
      setBusy(false);
    }
  }

  if (booking) {
    return (
      <main>
        <h1>You're booked</h1>
        <p>
          {booking.eventType.name} on <strong>{fmt(booking.start, tz, { dateStyle: 'full', timeStyle: 'short' })}</strong> ({tz})
        </p>
        <p>
          Keep this private link to view, reschedule or cancel:{' '}
          <Link to={`/manage/${booking.manageToken}`}>{location.origin}/manage/{booking.manageToken}</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <p><Link to="/">← Slotbook</Link></p>
      <h1>{info?.name ?? 'Book a time'}</h1>
      {info && (
        <p className="muted">
          {info.durationMin} min{info.capacity > 1 ? ` · group session, up to ${info.capacity}` : ''} · host {host}
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      {hold ? (
        <section className="card">
          <h2>{fmt(hold.start, tz, { dateStyle: 'full', timeStyle: 'short' })}</h2>
          <p className="muted">
            Held for you for {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
          </p>
          <form action={confirm}>
            <label>Name <input name="name" required autoComplete="name" /></label>
            <label>Email <input name="email" type="email" required autoComplete="email" /></label>
            <button type="submit" disabled={busy}>Confirm booking</button>{' '}
            <button type="button" onClick={() => setHold(null)}>Pick another time</button>
          </form>
        </section>
      ) : (
        <SlotPicker host={host} slug={slug} onPick={pick} disabled={busy} refreshKey={refresh} onLoaded={(r) => setInfo(r.eventType)} />
      )}
    </main>
  );
}
