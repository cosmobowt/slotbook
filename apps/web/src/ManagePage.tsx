import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, browserZone, fmt, type Booking, type Slot } from './api';
import { SlotPicker } from './SlotPicker';

export function ManagePage() {
  const { token = '' } = useParams();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'reschedule'>('view');
  const [tz, setTz] = useState(browserZone());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Booking>(`/api/bookings/${token}`).then(setBooking).catch((e) => setError(e.message));
  }, [token]);

  async function reschedule(slot: Slot, zone: string) {
    setBusy(true);
    setError(null);
    try {
      setBooking(await api<Booking>(`/api/bookings/${token}/reschedule`, { method: 'POST', json: { start: slot.start } }));
      setTz(zone);
      setMode('view');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const reason = prompt('Reason for cancelling (optional)') ?? undefined;
    setBusy(true);
    try {
      setBooking(await api<Booking>(`/api/bookings/${token}/cancel`, { method: 'POST', json: { reason } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!booking) return <main>{error ? <p className="error">{error}</p> : <p>Loading…</p>}</main>;

  return (
    <main>
      <p><Link to="/">← Slotbook</Link></p>
      <h1>{booking.eventType.name}</h1>
      {error && <p className="error" role="alert">{error}</p>}
      <p>
        <strong>{fmt(booking.start, tz, { dateStyle: 'full', timeStyle: 'short' })}</strong> ({tz}) ·{' '}
        <span className={`status ${booking.status}`}>{booking.status}</span>
      </p>
      <p className="muted">Booked by {booking.guestName} ({booking.guestEmail})</p>
      {booking.status === 'confirmed' && mode === 'view' && (
        <p>
          <button onClick={() => setMode('reschedule')} disabled={busy}>Reschedule</button>{' '}
          <button onClick={cancel} disabled={busy}>Cancel booking</button>
        </p>
      )}
      {mode === 'reschedule' && (
        <>
          <h2>Pick a new time</h2>
          <button onClick={() => setMode('view')}>Keep current time</button>
          <SlotPicker host={booking.eventType.host} slug={booking.eventType.slug} onPick={reschedule} disabled={busy} />
        </>
      )}
    </main>
  );
}
