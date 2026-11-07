import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchNotifications, defaultDeliver } from '../src/engine/notifier.js';
import { post, resetAndSeed, startTestEnv, tomorrowAt, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await resetAndSeed(env.db);
});

async function confirmedBooking(hhmm: string, email = 'obs@example.com') {
  const h = await post(env.baseUrl, '/api/holds', { host: 'tester', slug: 'call', start: await tomorrowAt(env.db, hhmm) });
  return post(env.baseUrl, `/api/holds/${h.body.holdId}/confirm`, { name: 'Obs', email });
}

const metric = (text: string, name: string) => {
  const line = text.split('\n').find((l) => l.split(' ')[0] === name);
  return line ? Number(line.split(' ').at(-1)) : undefined;
};

describe('observability (optional extension)', () => {
  it('/health reports the database time', async () => {
    const body = (await (await fetch(`${env.baseUrl}/health`)).json()) as any;
    expect(body.ok).toBe(true);
    expect(Date.parse(body.dbTime)).not.toBeNaN();
  });

  it('every response carries a request id, and a caller-supplied one is kept', async () => {
    const generated = await fetch(`${env.baseUrl}/health`);
    expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const supplied = await fetch(`${env.baseUrl}/health`, { headers: { 'x-request-id': 'trace-abc-123' } });
    expect(supplied.headers.get('x-request-id')).toBe('trace-abc-123');
  });

  it('/metrics counts bookings by status and pending notifications', async () => {
    await confirmedBooking('10:00');
    await post(env.baseUrl, '/api/holds', { host: 'tester', slug: 'call', start: await tomorrowAt(env.db, '12:00') });
    const text = await (await fetch(`${env.baseUrl}/metrics`)).text();
    expect(metric(text, 'slotbook_bookings{status="confirmed"}')).toBe(1);
    expect(metric(text, 'slotbook_bookings{status="held"}')).toBe(1);
    expect(metric(text, 'slotbook_bookings{status="expired"}')).toBe(0);
    expect(metric(text, 'slotbook_notifications_pending')).toBe(1);
    expect(metric(text, 'slotbook_notification_lag_seconds')).toBeGreaterThanOrEqual(0);
    expect(text).toContain('slotbook_http_responses_total{class="2xx"}');
  });
});

describe('notification dispatcher: at-least-once delivery to a local webhook', () => {
  let receiver: Server;
  let url: string;
  let received: { id: number; type: string }[] = [];
  let failNext = false;

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c)).on('end', () => {
        if (failNext) {
          failNext = false;
          res.writeHead(503).end();
          return;
        }
        received.push(JSON.parse(data));
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => receiver.close());
  beforeEach(() => {
    received = [];
    failNext = false;
  });

  it('delivers confirm/reschedule/cancel events in order and marks them delivered', async () => {
    const c = await confirmedBooking('10:00');
    await post(env.baseUrl, `/api/bookings/${c.body.manageToken}/reschedule`, { start: await tomorrowAt(env.db, '11:00') });
    await post(env.baseUrl, `/api/bookings/${c.body.manageToken}/cancel`, { reason: 'test' });

    process.env.NOTIFY_WEBHOOK_URL = url;
    const r = await dispatchNotifications(env.db, defaultDeliver(() => {}));
    delete process.env.NOTIFY_WEBHOOK_URL;

    expect(r).toEqual({ delivered: 3, failed: false });
    expect(received.map((n) => n.type)).toEqual(['booking.confirmed', 'booking.rescheduled', 'booking.cancelled']);
    const { rows } = await env.db.query('SELECT count(*)::int AS n FROM notifications WHERE delivered_at IS NULL');
    expect(rows[0].n).toBe(0);
  });

  it('a failing receiver leaves the event pending, and the next tick delivers it', async () => {
    await confirmedBooking('10:00');
    process.env.NOTIFY_WEBHOOK_URL = url;
    failNext = true;
    const first = await dispatchNotifications(env.db, defaultDeliver(() => {}));
    const second = await dispatchNotifications(env.db, defaultDeliver(() => {}));
    delete process.env.NOTIFY_WEBHOOK_URL;

    expect(first).toEqual({ delivered: 0, failed: true });
    expect(second).toEqual({ delivered: 1, failed: false });
    expect(received).toHaveLength(1);
  });
});
