import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { z } from 'zod';
import { startSession, stepSession, getSessionState, screenshotSession, closeSession, collectAvailability, advanceSession, bindSessionToCall, resolveSessionId, getSessionNetwork, fetchTextViaSession } from './sessionDriver.js';

const app = express();
const PORT = process.env.PORT || 10000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY || '';
const BROWSERLESS_REGION = process.env.BROWSERLESS_REGION || 'production-sfo.browserless.io';
const LIVE_BOOKING_ENABLED = process.env.LIVE_BOOKING_ENABLED === 'true';

const DEALER_NAME = 'Brandon Honda';
const DEALER_ADDRESS = '9209 E Adamo Dr, Tampa, FL 33619';
const SCHEDULER_URL = 'https://r7699369.m.reyrey.net/service-portal/?token=FE1B2C28E80E4182A2084EA7EAAEE51C';

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
  service_label: z.string().optional(),
  service_free_text: z.string().optional().default(''),
  service_concern: z.string().min(1),
  additional_services: z.string().optional().default('none'),
  transport_option: z.string().optional(),
  transportation_plan: z.string().min(1),
  preferred_date: z.string().min(1),
  preferred_time: z.string().min(1),
  customer_email: z.string().optional(),
  confirmation_method: z.string().optional(),
  sms_consent: z.union([z.boolean(), z.string()]).optional(),
  consent_recorded: z.union([z.boolean(), z.string()]).optional(),
  dealer: z.string().optional(),
  scheduler_url: z.string().url().optional()
});

const availabilitySchema = z.object({
  operation: z.string().optional(),
  call_id: z.string().optional(),
  session_id: z.string().optional(),
  dealer: z.string().optional(),
  vehicle_year: z.union([z.string(), z.number()]).optional(),
  vehicle_model: z.string().optional(),
  vehicle_mileage: z.union([z.string(), z.number()]).optional(),
  service_label: z.string().optional(),
  service_free_text: z.string().optional(),
  service_concern: z.string().optional(),
  transportation_plan: z.string().optional(),
  transport_option: z.string().optional(),
  preferred_date: z.string().min(1).optional()
});

const inMemoryRequests = new Map();

function requireAuth(req, res, next) {
  if (!WEBHOOK_SECRET) return next();
  const auth = req.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (token !== WEBHOOK_SECRET) return res.status(401).json({ success: false, message: 'Unauthorized' });
  return next();
}

function normalizeTime(value) {
  const raw = String(value || '').trim();
  const match24 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match24) return raw;
  let hour = Number(match24[1]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return hour + ':' + match24[2] + ' ' + suffix;
}

function mapServicePattern(serviceConcern = '') {
  const s = String(serviceConcern).toLowerCase();
  if (s.includes('tire') && s.includes('rotation')) return 'TIRE ROTATION';
  if (s.includes('align') || s.includes('pull')) return 'ALIGN VEHICLE';
  if (s.includes('brake fluid')) return 'BRAKE FLUID SERVICE';
  if (s.includes('battery') || s.includes('start')) return 'REPLACE BATTERY';
  if (s.includes('recall')) return 'RECALL';
  if (s.includes('oil')) return 'OIL CHANGE';
  return 'OIL CHANGE';
}

function browserlessEndpoint() {
  return 'https://' + BROWSERLESS_REGION + '/function?token=' + encodeURIComponent(BROWSERLESS_API_KEY);
}

async function runBrowserlessFunction(code, context = {}) {
  if (!BROWSERLESS_API_KEY) {
    return { ok: false, status: 'browserless_not_configured', message: 'BROWSERLESS_API_KEY is not configured on the service.' };
  }
  const response = await fetch(browserlessEndpoint(), {
    method: 'POST',
    headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, context })
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_err) { parsed = { raw: text.slice(0, 4000) }; }
  if (!response.ok) return { ok: false, status: 'browserless_error', http_status: response.status, details: parsed };
  return parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
}

function browserTask({ page, context }) {
  return (async () => {
    const targetUrl = context.url;
    const steps = context.steps || [];
    const full = Boolean(context.full);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function getFrame() {
      for (let i = 0; i < 20; i++) {
        const frame = page.frames().find(f => /reyrey\.net|service-portal/i.test(f.url()));
        if (frame) return frame;
        await delay(500);
      }
      return null;
    }
    async function getState(frame) {
      if (!frame) return { error: 'no_frame' };
      return frame.evaluate((full) => {
        const compact = s => (s || '').replace(/\s+/g, ' ').trim();
        const fields = Array.from(document.querySelectorAll('input, select, textarea')).map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          id: el.id || '',
          name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || '',
          value: el.value || '',
          checked: Boolean(el.checked),
          disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true'
        })).slice(0, full ? 150 : 70);
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, label, [tabindex]')).map((el, index) => ({
          index,
          text: compact(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || ''),
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          disabled: Boolean(el.disabled) || /disabled/i.test(String(el.className || '')) || el.getAttribute('aria-disabled') === 'true'
        })).filter(b => b.text).slice(0, full ? 220 : 140);
        return { url: location.href, title: document.title, text: compact((document.body && document.body.innerText) || '').slice(0, full ? 6000 : 3500), fields, buttons };
      }, full);
    }
    async function waitForCondition(frame, condition = {}, timeoutMs = 5000) {
      const started = Date.now();
      const mode = condition.mode || (condition.text ? 'textIncludes' : 'settle');
      const value = String(condition.value || condition.text || '').toLowerCase();
      while (Date.now() - started < timeoutMs) {
        try {
          const state = await getState(frame);
          const text = String(state.text || '').toLowerCase();
          if (mode === 'textIncludes' && value && text.includes(value)) return { ok: true, mode, value: condition.value || condition.text, elapsedMs: Date.now() - started };
          if (mode === 'textExcludes' && value && !text.includes(value)) return { ok: true, mode, value: condition.value || condition.text, elapsedMs: Date.now() - started };
          if (mode === 'urlIncludes' && value && String(state.url || '').toLowerCase().includes(value)) return { ok: true, mode, value: condition.value || condition.text, elapsedMs: Date.now() - started };
          if (mode === 'controlIncludes' && value && (state.buttons || []).some(b => String(b.text || '').toLowerCase().includes(value))) return { ok: true, mode, value: condition.value || condition.text, elapsedMs: Date.now() - started };
          if (mode === 'settle' && Date.now() - started >= 250) return { ok: true, mode, elapsedMs: Date.now() - started };
        } catch (_err) {}
        await delay(100);
      }
      return { ok: false, mode, value: condition.value || condition.text, elapsedMs: Date.now() - started };
    }
    async function clickText(frame, patternText, pick = 'shortest') {
      return frame.evaluate(({ patternText, pick }) => {
        const compact = s => (s || '').replace(/\s+/g, ' ').trim();
        const re = new RegExp(patternText, 'i');
        const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, [tabindex]'));
        const matches = candidates.map(el => {
          const text = compact(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '');
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const disabled = Boolean(el.disabled) || /disabled/i.test(String(el.className || '')) || el.getAttribute('aria-disabled') === 'true';
          const visible = style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          return { el, text, disabled, visible, score: text.length };
        }).filter(item => item.text && re.test(item.text));
        const enabled = matches.filter(item => !item.disabled);
        const visibleEnabled = enabled.filter(item => item.visible);
        let pool = visibleEnabled.length ? visibleEnabled : (enabled.length ? enabled : matches);
        if (pick === 'last') pool = pool.slice().reverse();
        else if (pick === 'shortest') pool = pool.slice().sort((a, b) => a.score - b.score);
        const target = pool[0];
        if (!target) return { ok: false, type: 'clickText', patternText, pick };
        target.el.scrollIntoView({ block: 'center', inline: 'center' });
        target.el.click();
        return { ok: true, type: 'clickText', patternText, pick, text: target.text, disabled: target.disabled, visible: target.visible, matchCount: matches.length };
      }, { patternText, pick });
    }
    async function clickNearbyInput(frame, patternText, inputType = 'checkbox') {
      return frame.evaluate(({ patternText, inputType }) => {
        const compact = s => (s || '').replace(/\s+/g, ' ').trim();
        const re = new RegExp(patternText, 'i');
        const textEls = Array.from(document.querySelectorAll('div, span, p, label, button, li'))
          .map(el => ({ el, text: compact(el.innerText || el.textContent || '') }))
          .filter(item => item.text && re.test(item.text))
          .sort((a, b) => a.text.length - b.text.length);
        for (const item of textEls) {
          let node = item.el;
          for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
            const input = node.querySelector && node.querySelector('input[type="' + inputType + '"]');
            if (input) {
              input.scrollIntoView({ block: 'center', inline: 'center' });
              input.click();
              return { ok: true, type: 'clickNearbyInput', patternText, matchedText: item.text, inputType, checked: Boolean(input.checked) };
            }
          }
        }
        return { ok: false, type: 'clickNearbyInput', patternText, inputType, reason: 'not_found' };
      }, { patternText, inputType });
    }
    async function clickSelector(frame, selector, index = 0) {
      return frame.evaluate(({ selector, index }) => {
        const matches = Array.from(document.querySelectorAll(selector));
        const el = matches[index];
        if (!el) return { ok: false, type: 'clickSelector', selector, index, matchCount: matches.length, reason: 'not_found' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return { ok: true, type: 'clickSelector', selector, index, matchCount: matches.length, checked: Boolean(el.checked) };
      }, { selector, index });
    }
    async function fill(frame, selector, value) {
      return frame.evaluate(({ selector, value }) => {
        const el = document.querySelector(selector);
        if (!el) return { ok: false, type: 'fill', selector, reason: 'not_found' };
        el.focus();
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, String(value)); else el.value = String(value);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: String(value).slice(-1) || '0' }));
        el.blur();
        return { ok: true, type: 'fill', selector, value: String(value), currentValue: el.value };
      }, { selector, value });
    }
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      let frame = await getFrame();
      const results = [];
      for (const step of steps) {
        const action = typeof step === 'string' ? { type: 'clickText', pattern: step, pick: 'shortest' } : step;
        if (context.stopBeforeFinalSubmit !== false && action.finalSubmit === true) {
          results.push({ action, result: { ok: false, type: 'blockedFinalSubmit', reason: 'final_submit_disabled' } });
          break;
        }
        let result;
        for (let attempt = 0; attempt < 6; attempt++) {
          if (action.type === 'clickText') result = await clickText(frame, action.pattern, action.pick || 'shortest');
          else if (action.type === 'fill') result = await fill(frame, action.selector, action.value);
          else if (action.type === 'clickSelector') result = await clickSelector(frame, action.selector, action.index || 0);
          else if (action.type === 'clickNearbyInput') result = await clickNearbyInput(frame, action.pattern, action.inputType || 'checkbox');
          else result = { ok: false, reason: 'unknown_action', action };
          if (result.ok !== false) break;
          await waitForCondition(frame, action.retryUntil || { mode: 'settle' }, action.retryWaitMs || 1000);
          frame = await getFrame();
        }
        results.push({ action, result });
        if (action.waitFor) await waitForCondition(frame, action.waitFor, action.waitTimeoutMs || 5000);
        else if (action.waitMs) await waitForCondition(frame, { mode: 'settle' }, Math.min(Number(action.waitMs) || 250, 500));
        frame = await getFrame();
        if (result.ok === false) break;
      }
      return { data: { ok: true, status: 'mapped_steps', results, finalState: await getState(frame) }, type: 'application/json' };
    } catch (err) {
      return { data: { ok: false, status: 'exception', error: err && err.message ? err.message : String(err) }, type: 'application/json' };
    }
  })();
}

async function mapFlow(steps, full = false) {
  return runBrowserlessFunction('export default ' + browserTask.toString(), {
    url: SCHEDULER_URL,
    steps,
    full,
    stopBeforeFinalSubmit: true
  });
}

async function runBrowserlessProbe() {
  const result = await mapFlow([
    { type: 'clickText', pattern: 'Schedule Appointment', pick: 'shortest', waitFor: { mode: 'textIncludes', text: "I'M NEW" } },
    { type: 'clickText', pattern: "I'm new", pick: 'shortest', waitFor: { mode: 'textIncludes', text: 'Honda' } }
  ], false);
  return {
    ...result.finalState,
    ok: Boolean(result.ok),
    status: result.status,
    reynoldsFrame: result.finalState ? { url: result.finalState.url, title: result.finalState.title } : null,
    reynoldsStartClicked: Boolean(result.results?.[0]?.result?.ok)
  };
}

async function bookWithPortal(input) {
  const validation = await mapFlow([
    { type: 'clickText', pattern: 'Schedule Appointment', pick: 'shortest', waitMs: 3000 },
    { type: 'clickText', pattern: "I'm new", pick: 'shortest', waitMs: 3000 },
    { type: 'clickText', pattern: '^Honda$', pick: 'shortest', waitMs: 2000 },
    { type: 'clickText', pattern: '^' + (input.vehicle_year || '2023') + '$', pick: 'shortest', waitMs: 2000 },
    { type: 'clickText', pattern: '^' + (input.vehicle_model || 'CR-V') + '$', pick: 'shortest', waitMs: 2000 },
    { type: 'clickSelector', selector: '#estMilCheckbox', waitMs: 1200 },
    { type: 'clickText', pattern: '^Proceed$', pick: 'last', waitMs: 2500 },
    { type: 'clickNearbyInput', pattern: '^' + mapServicePattern(input.service_concern) + '$', waitMs: 1500 },
    { type: 'clickText', pattern: '^Proceed$', pick: 'last', waitMs: 3000 }
  ], false);

  return {
    success: false,
    status: validation.ok ? 'dry_run_no_booking' : 'dry_run_failed',
    confirmation_number: null,
    date: null,
    time: null,
    message: validation.ok
      ? `Dry-run only. Browserless validated the ${DEALER_NAME} Reynolds scheduling flow through vehicle and service selection, but no appointment was created.`
      : `Could not validate the Reynolds scheduling flow for ${DEALER_NAME}. Transfer caller to the service team.`,
    available_slots: [],
    slots: [],
    proof_url: null,
    dealer: DEALER_NAME,
    address: DEALER_ADDRESS,
    portal_probe: { ok: Boolean(validation.ok), status: validation.status, lastScreenText: validation.finalState?.text?.slice(0, 1200) || null },
    live_submit_enabled: LIVE_BOOKING_ENABLED
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'brandon-honda-booking-service', mode: LIVE_BOOKING_ENABLED ? 'live_submit' : 'safe', browserlessConfigured: Boolean(BROWSERLESS_API_KEY), liveSubmitEnabled: LIVE_BOOKING_ENABLED, liveAvailabilityEnabled: LIVE_AVAILABILITY_ENABLED, poolSize: Number(process.env.SESSION_POOL_SIZE || '1') });
});

app.get('/', (_req, res) => {
  const routes = app._router.stack
    .filter(layer => layer.route)
    .map(layer => ({ path: layer.route.path, methods: Object.keys(layer.route.methods).sort() }));
  res.json({ service: 'brandon-honda-booking-service', dealer: DEALER_NAME, scheduler_url: SCHEDULER_URL, mode: LIVE_BOOKING_ENABLED ? 'live_submit' : 'safe', public_endpoints: ['/health'], routes });
});

const LIVE_AVAILABILITY_ENABLED = process.env.LIVE_AVAILABILITY_ENABLED !== 'false';

// Read-only. Walks the (pre-warmed) portal session to the time grid for the caller's date and
// transport row and returns the open times in the portal's own format (e.g. "09:30am").
// Never reaches the review screen; never touches ADD APPOINTMENT. Fails closed: anything
// other than a positively extracted slot list returns success:false, and the Bland pathway
// routes that to a transfer.
app.post('/availability', requireAuth, async (req, res) => {
  const parsed = availabilitySchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Invalid availability payload', issues: parsed.error.issues });
  const input = parsed.data;
  const base = { dealer: DEALER_NAME, address: DEALER_ADDRESS, date: input.preferred_date || null, transport_option: input.transport_option || input.transportation_plan || null, call_id: input.call_id || null };
  if (!LIVE_AVAILABILITY_ENABLED) {
    return res.status(200).json({ ...base, success: false, status: 'availability_disabled', slots: [], available_slots: [], message: 'Live availability is disabled by LIVE_AVAILABILITY_ENABLED=false.' });
  }
  if (!input.preferred_date) {
    return res.status(200).json({ ...base, success: false, status: 'missing_date', slots: [], available_slots: [], message: 'preferred_date (MM/DD/YYYY) is required.' });
  }
  const debug = String(req.query?.debug || req.body?.debug || '') === '1';
  try {
    const result = await collectAvailability(input.session_id, input);
    const slots = Array.isArray(result.slots) ? result.slots : [];
    const success = Boolean(result.ok) && slots.length > 0;
    const body = {
      ...base,
      success,
      status: success ? 'availability_live' : (result.ok ? 'no_openings' : result.status),
      slots,
      available_slots: slots,
      session_id: result.session_id || input.session_id || null,
      transport_matched: result.transport_matched || null,
      stage: result.stage || null,
      message: success
        ? `${slots.length} open time${slots.length === 1 ? '' : 's'} on ${input.preferred_date} for ${base.transport_option}.`
        : (result.ok ? `No open times on ${input.preferred_date} for ${base.transport_option}.` : `Could not read availability from the scheduler (${result.status}). Transfer caller to the service team.`),
      elapsed_ms: result.elapsed_ms || null
    };
    if (debug || !success) body.debug = { trace: result.trace, last_screen_text: result.last_screen_text, error: result.error, detail: result.detail };
    console.log(JSON.stringify({ event: 'availability', call_id: input.call_id || null, success, status: body.status, count: slots.length, elapsed_ms: body.elapsed_ms, trace: result.trace }));
    res.status(200).json(body);
  } catch (err) {
    console.error('availability_unhandled', err);
    res.status(200).json({ ...base, success: false, status: 'availability_unhandled', slots: [], available_slots: [], message: 'Availability lookup failed. Transfer caller to the service team.', error: err?.message || String(err) });
  }
});

app.get('/portal-probe', requireAuth, async (_req, res) => {
  const probe = await runBrowserlessProbe();
  res.status(probe.ok ? 200 : 502).json(probe);
});

app.post('/portal-probe', requireAuth, async (_req, res) => {
  const probe = await runBrowserlessProbe();
  res.status(probe.ok ? 200 : 502).json(probe);
});

app.get('/validate-process', requireAuth, async (_req, res) => {
  const probe = await runBrowserlessProbe();
  const sampleBooking = await bookWithPortal({ vehicle_year: '2023', vehicle_model: 'CR-V', service_concern: 'oil change', preferred_date: '09/05/2026', preferred_time: '09:30', scheduler_url: SCHEDULER_URL });
  res.status(probe.ok ? 200 : 502).json({ ok: Boolean(probe.ok), mode: LIVE_BOOKING_ENABLED ? 'live_submit' : 'safe', browserlessConfigured: Boolean(BROWSERLESS_API_KEY), liveSubmitEnabled: LIVE_BOOKING_ENABLED, portal: compactValidationFromProbe(probe), bookingDryRun: { success: sampleBooking.success, status: sampleBooking.status, message: sampleBooking.message, confirmation_number: sampleBooking.confirmation_number, live_submit_enabled: sampleBooking.live_submit_enabled } });
});

app.post('/map-flow', requireAuth, async (req, res) => {
  const result = await mapFlow(req.body?.steps || [], true);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/mvp-dry-run', requireAuth, async (req, res) => {
  const result = await bookWithPortal({ vehicle_year: req.body?.vehicle_year || '2023', vehicle_model: req.body?.vehicle_model || 'CR-V', service_concern: req.body?.service_concern || 'oil change', preferred_date: req.body?.preferred_date || '09/05/2026', preferred_time: req.body?.preferred_time || '09:30', scheduler_url: SCHEDULER_URL });
  res.status(200).json(result);
});

app.post('/map-flow-compact', requireAuth, async (req, res) => {
  const result = await mapFlow(req.body?.steps || [], false);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/next-state', requireAuth, async (req, res) => {
  const result = await mapFlow(req.body?.steps || [], false);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/sessions/start', requireAuth, async (req, res) => {
  try {
    const existing = resolveSessionId({ call_id: req.body?.call_id });
    if (existing) return res.status(200).json({ ok: true, success: true, id: existing, session_id: existing, reused: true });
    const result = await startSession({ url: req.body?.url || SCHEDULER_URL });
    if (result.ok) result.success = true;
    if (result.id && !result.session_id) result.session_id = result.id;
    if (result.ok && req.body?.call_id) bindSessionToCall(result.id, String(req.body.call_id));
    res.status(result.ok === false ? 502 : 200).json(result);
  } catch (err) {
    console.error('session_start_unhandled', err);
    res.status(500).json({ ok: false, status: 'session_start_unhandled', error: err?.message || String(err) });
  }
});

// Background pre-advance. The pathway calls this as soon as it knows the vehicle, then again
// with the service, then with transport/date. Returns immediately; the walk continues under the
// session lock so a later /availability call waits for it instead of racing it. Pass ?wait=1
// to block for the result (testing). Sessions are found by session_id or, failing that, call_id.
app.post(['/sessions/advance', '/sessions/:id/advance'], requireAuth, async (req, res) => {
  const body = req.body || {};
  const ref = { session_id: req.params.id || body.session_id, call_id: body.call_id ? String(body.call_id) : undefined };
  const wait = String(req.query?.wait || body.wait || '') === '1';
  try {
    const result = await advanceSession(ref, body, { until: body.until, wait });
    console.log(JSON.stringify({ event: 'advance', call_id: ref.call_id || null, wait, ok: result.ok, status: result.status, stage: result.stage, target: result.target, elapsed_ms: result.elapsed_ms }));
    res.status(200).json(result);
  } catch (err) {
    console.error('advance_unhandled', err);
    res.status(500).json({ ok: false, status: 'advance_unhandled', error: err?.message || String(err) });
  }
});

app.post('/sessions/:id/step', requireAuth, async (req, res) => {
  try {
    const result = await stepSession(req.params.id, req.body?.steps || []);
    res.status(result.ok ? 200 : result.status === 'session_not_found' ? 404 : 400).json(result);
  } catch (err) {
    console.error('session_step_unhandled', err);
    res.status(500).json({ ok: false, status: 'session_step_unhandled', error: err?.message || String(err) });
  }
});

// Captured portal API traffic for a session (mapping aid for a direct-API integration).
app.get('/sessions/:id/network', requireAuth, async (req, res) => {
  try {
    const id = resolveSessionId({ session_id: req.params.id, call_id: req.query?.call_id }) || req.params.id;
    const result = await getSessionNetwork(id, req.query?.since);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, status: 'network_unhandled', error: err?.message || String(err) });
  }
});

app.post('/sessions/:id/fetch-text', requireAuth, async (req, res) => {
  try {
    const result = await fetchTextViaSession(req.params.id, req.body?.url, { grep: req.body?.grep, context: req.body?.context, maxSnippets: req.body?.maxSnippets, maxText: req.body?.maxText });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, status: 'fetch_text_unhandled', error: err?.message || String(err) });
  }
});

app.get('/sessions/:id/state', requireAuth, async (req, res) => {
  try {
    const result = await getSessionState(req.params.id);
    res.status(result.ok ? 200 : result.status === 'session_not_found' ? 404 : 400).json(result);
  } catch (err) {
    console.error('session_state_unhandled', err);
    res.status(500).json({ ok: false, status: 'session_state_unhandled', error: err?.message || String(err) });
  }
});

app.get('/sessions/:id/screenshot', requireAuth, async (req, res) => {
  try {
    const result = await screenshotSession(req.params.id);
    res.status(result.ok ? 200 : result.status === 'session_not_found' ? 404 : 400).json(result);
  } catch (err) {
    console.error('session_screenshot_unhandled', err);
    res.status(500).json({ ok: false, status: 'session_screenshot_unhandled', error: err?.message || String(err) });
  }
});

app.delete('/sessions/:id', requireAuth, async (req, res) => {
  try {
    const result = await closeSession(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    console.error('session_close_unhandled', err);
    res.status(500).json({ ok: false, status: 'session_close_unhandled', error: err?.message || String(err) });
  }
});

app.post('/book-service', requireAuth, async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Invalid booking payload', issues: parsed.error.issues });
  const key = parsed.data.call_id || `${parsed.data.caller_phone}-${parsed.data.customer_name}-${parsed.data.preferred_date}-${parsed.data.preferred_time}`;
  if (inMemoryRequests.has(key)) return res.json({ ...inMemoryRequests.get(key), idempotent_replay: true });
  const result = await bookWithPortal(parsed.data);
  const response = { ...result, call_id: parsed.data.call_id || null, vehicle: { year: parsed.data.vehicle_year || null, model: parsed.data.vehicle_model, mileage: parsed.data.vehicle_mileage || null }, service_label: parsed.data.service_label || null, service_free_text: parsed.data.service_free_text || '', service_concern: parsed.data.service_concern, additional_services: parsed.data.additional_services || 'none', transport_option: parsed.data.transport_option || parsed.data.transportation_plan, transportation_plan: parsed.data.transportation_plan, customer_email: parsed.data.customer_email || null, confirmation_method: parsed.data.confirmation_method || null, sms_consent: parsed.data.sms_consent ?? null, consent_recorded: parsed.data.consent_recorded ?? null, scheduler_url: SCHEDULER_URL };
  inMemoryRequests.set(key, response);
  res.status(200).json(response);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Brandon Honda booking service listening on ${PORT} with LIVE_BOOKING_ENABLED=${LIVE_BOOKING_ENABLED}`);
});
