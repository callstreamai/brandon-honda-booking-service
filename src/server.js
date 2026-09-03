import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { z } from 'zod';

const app = express();
const PORT = process.env.PORT || 10000;
const MODE = process.env.BOOKING_MODE || 'safe'; // safe | live
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DEALER_NAME = 'Brandon Honda';
const DEALER_ADDRESS = '9209 E Adamo Dr, Tampa, FL 33619';
const SCHEDULER_URL = 'https://brandonhonda.com/brandon-honda-service-department/schedule-service/';

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

const bookingSchema = z.object({
  operation: z.string().optional(),
  call_id: z.string().min(1).optional(),
  caller_phone: z.string().min(7).optional(),
  customer_name: z.string().min(1),
  vehicle_year: z.union([z.string(), z.number()]).optional(),
  vehicle_model: z.string().min(1),
  vehicle_mileage: z.union([z.string(), z.number()]).optional(),
  service_concern: z.string().min(1),
  additional_services: z.string().optional().default('none'),
  transportation_plan: z.string().min(1),
  preferred_date: z.string().min(1),
  preferred_time: z.string().min(1),
  dealer: z.string().optional(),
  scheduler_url: z.string().url().optional()
});

const availabilitySchema = z.object({
  vehicle_year: z.union([z.string(), z.number()]).optional(),
  vehicle_model: z.string().optional(),
  service_concern: z.string().optional(),
  transportation_plan: z.string().optional(),
  preferred_date: z.string().min(1).optional()
});

const inMemoryBookings = new Map();

function requireAuth(req, res, next) {
  if (!WEBHOOK_SECRET) return next();
  const auth = req.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (token !== WEBHOOK_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  return next();
}

function normalizeTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const match24 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    let hour = Number(match24[1]);
    const minute = match24[2];
    const suffix = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return `${hour}:${minute} ${suffix}`;
  }
  return raw;
}

function makeConfirmation(callId = '') {
  const source = callId || `${Date.now()}-${Math.random()}`;
  let hash = 0;
  for (const ch of source) hash = (hash * 31 + ch.charCodeAt(0)) % 10000;
  return `BH${String(hash).padStart(4, '0')}`;
}

function nearestDemoSlots(preferredDate) {
  const date = preferredDate || 'next business day';
  return [
    { date, time: '9:00 AM', transportation_options: ['drop-off', 'waiting'] },
    { date, time: '11:30 AM', transportation_options: ['drop-off', 'loaner'] },
    { date, time: '2:15 PM', transportation_options: ['drop-off', 'shuttle', 'rideshare'] }
  ];
}

async function bookWithPortal(input) {
  if (MODE !== 'live') {
    const confirmation = makeConfirmation(input.call_id);
    return {
      success: true,
      status: 'simulated',
      confirmation_number: confirmation,
      date: input.preferred_date,
      time: normalizeTime(input.preferred_time),
      message: `Draft/safe-mode confirmation for ${DEALER_NAME}. Live Reynolds booking is not enabled on this service yet.`,
      available_slots: [],
      proof_url: null,
      dealer: DEALER_NAME,
      address: DEALER_ADDRESS
    };
  }

  // Live mode intentionally fails closed until the Reynolds driver is implemented and validated.
  // This prevents the voice agent from claiming a confirmed booking without portal proof.
  return {
    success: false,
    status: 'live_driver_not_configured',
    confirmation_number: null,
    date: input.preferred_date,
    time: normalizeTime(input.preferred_time),
    message: 'Live Reynolds portal driver is not configured. Transfer caller to the Brandon Honda service team.',
    available_slots: nearestDemoSlots(input.preferred_date),
    proof_url: null,
    dealer: DEALER_NAME,
    address: DEALER_ADDRESS
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'brandon-honda-booking-service', mode: MODE });
});

app.get('/', (_req, res) => {
  res.json({
    service: 'brandon-honda-booking-service',
    dealer: DEALER_NAME,
    scheduler_url: SCHEDULER_URL,
    mode: MODE,
    endpoints: ['/health', '/availability', '/book-service']
  });
});

app.post('/availability', requireAuth, (req, res) => {
  const parsed = availabilitySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid availability payload', issues: parsed.error.issues });
  }
  res.json({
    success: true,
    status: MODE === 'live' ? 'live_driver_not_configured' : 'simulated',
    available_slots: nearestDemoSlots(parsed.data.preferred_date),
    message: MODE === 'live'
      ? 'Live Reynolds availability driver is not configured yet.'
      : 'Safe-mode demo availability returned. Not from Reynolds.',
    dealer: DEALER_NAME,
    address: DEALER_ADDRESS
  });
});

app.post('/book-service', requireAuth, async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid booking payload', issues: parsed.error.issues });
  }

  const key = parsed.data.call_id || `${parsed.data.caller_phone}-${parsed.data.customer_name}-${parsed.data.preferred_date}-${parsed.data.preferred_time}`;
  if (inMemoryBookings.has(key)) {
    return res.json({ ...inMemoryBookings.get(key), idempotent_replay: true });
  }

  const result = await bookWithPortal(parsed.data);
  const response = {
    ...result,
    call_id: parsed.data.call_id || null,
    vehicle: {
      year: parsed.data.vehicle_year || null,
      model: parsed.data.vehicle_model,
      mileage: parsed.data.vehicle_mileage || null
    },
    service_concern: parsed.data.service_concern,
    additional_services: parsed.data.additional_services || 'none',
    transportation_plan: parsed.data.transportation_plan,
    scheduler_url: SCHEDULER_URL
  };
  inMemoryBookings.set(key, response);
  res.status(response.success ? 200 : 409).json(response);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Brandon Honda booking service listening on ${PORT} in ${MODE} mode`);
});
