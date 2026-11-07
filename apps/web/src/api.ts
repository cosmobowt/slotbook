export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  const token = localStorage.getItem('slotbook.hostToken');
  if (token && path.startsWith('/api/host')) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? res.statusText);
  return body as T;
}

export interface Slot {
  start: string;
  end: string;
  localDate: string;
  localTime: string;
  seatsLeft: number;
}

export interface SlotsResponse {
  eventType: { host: string; slug: string; name: string; durationMin: number; capacity: number; hostTimezone: string };
  timezone: string;
  slots: Slot[];
}

export interface Booking {
  id: string;
  status: string;
  start: string;
  end: string;
  guestName: string | null;
  guestEmail: string | null;
  manageToken: string | null;
  cancelReason: string | null;
  eventType: { host: string; slug: string; name: string; durationMin: number; hostTimezone: string };
}

export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const ZONES = [
  'Asia/Kolkata', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin',
  'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];

export function fmt(iso: string, zone: string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: zone }).format(new Date(iso));
}
