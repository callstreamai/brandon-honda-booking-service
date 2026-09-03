import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { z } from 'zod';

const app = express();
const PORT = process.env.PORT || 10000;
const MODE = process.env.BOOKING_MODE || 'safe'; // safe | live
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY || '';
const BROWSERLESS_REGION = process.env.BROWSERLESS_REGION || 'production-sfo.browserless.io';
const ALLOW_LIVE_SUBMIT = process.env.ALLOW_LIVE_SUBMIT === 'true';
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

async function runBrowserlessProbe(context = {}) {
  if (!BROWSERLESS_API_KEY) {
    return {
      ok: false,
      status: 'browserless_not_configured',
      message: 'BROWSERLESS_API_KEY is not configured on the service.'
    };
  }

  const endpoint = `https://${BROWSERLESS_REGION}/function?token=${encodeURIComponent(BROWSERLESS_API_KEY)}`;
  const code = `
export default async ({ page, context }) => {
  const targetUrl = context.url;
  const result = {
    ok: false,
    targetUrl,
    finalUrl: null,
    title: null,
    hasSchedulerCopy: false,
    hasAppointmentCopy: false,
    iframeCount: 0,
    iframeSources: [],
    inputCount: 0,
    buttonTexts: [],
    linkHrefs: [],
    textSample: '',
    reynoldsFrame: null,
    error: null
  };
  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 3000));
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 700);
          total += 700;
          if (total > Math.min(document.body.scrollHeight, 5000)) {
            clearInterval(timer);
            resolve();
          }
        }, 250);
      });
    });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const data = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const lower = text.toLowerCase();
      return {
        finalUrl: location.href,
        title: document.title,
        hasSchedulerCopy: lower.includes('schedule service') || lower.includes('service scheduling'),
        hasAppointmentCopy: lower.includes('appointment'),
        iframeCount: document.querySelectorAll('iframe').length,
        iframeSources: Array.from(document.querySelectorAll('iframe')).map(f => f.src).filter(Boolean).slice(0, 20),
        inputCount: document.querySelectorAll('input, select, textarea').length,
        buttonTexts: Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a')).map(el => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 40),
        linkHrefs: Array.from(document.querySelectorAll('a')).map(a => a.href).filter(Boolean).filter(h => /schedule|service|appointment|reynolds|xtime|dealer/i.test(h)).slice(0, 40),
        textSample: text.slice(0, 2000)
      };
    });
    const frames = page.frames();
    const reynoldsFrame = frames.find(frame => /reyrey\.net|service-portal/i.test(frame.url()));
    if (reynoldsFrame) {
      try {
        const frameData = await reynoldsFrame.evaluate(() => {
          const text = document.body?.innerText || '';
          return {
            url: location.href,
            title: document.title,
            textSample: text.slice(0, 2000),
            inputCount: document.querySelectorAll('input, select, textarea').length,
            buttonTexts: Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a')).map(el => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 60),
            labels: Array.from(document.querySelectorAll('label')).map(el => (el.innerText || '').trim()).filter(Boolean).slice(0, 60)
          };
        });
        data.reynoldsFrame = frameData;
        const clickedStart = await reynoldsFrame.evaluate(() => {
          const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const target = elements.find(el => /schedule appointment/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()));
          if (!target) return false;
          target.click();
          return true;
        });
        data.reynoldsStartClicked = clickedStart;
        if (clickedStart) {
          await new Promise(resolve => setTimeout(resolve, 2500));
          data.reynoldsAfterStart = await reynoldsFrame.evaluate(() => {
            const text = document.body?.innerText || '';
            return {
              url: location.href,
              title: document.title,
              textSample: text.slice(0, 2500),
              inputCount: document.querySelectorAll('input, select, textarea').length,
              buttonTexts: Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a')).map(el => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 80),
              labels: Array.from(document.querySelectorAll('label')).map(el => (el.innerText || '').trim()).filter(Boolean).slice(0, 80)
            };
          });
        }
      } catch (frameErr) {
        data.reynoldsFrame = { url: reynoldsFrame.url(), error: frameErr && frameErr.message ? frameErr.message : String(frameErr) };
      }
    }
    Object.assign(result, data, { ok: true });
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
  }
  return { data: result, type: 'application/json' };
};`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ code, context: { url: context.url || SCHEDULER_URL } })
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    parsed = { raw: text.slice(0, 2000) };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 'browserless_error',
      http_status: response.status,
      message: 'Browserless probe failed.',
      details: parsed
    };
  }

  const payload = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  return payload;
}

async function runGuestFlowMap(context = {}) {
  if (!BROWSERLESS_API_KEY) {
    return { ok: false, status: 'browserless_not_configured', message: 'BROWSERLESS_API_KEY is not configured on the service.' };
  }

  const endpoint = `https://${BROWSERLESS_REGION}/function?token=${encodeURIComponent(BROWSERLESS_API_KEY)}`;
  const code = `
export default async ({ page, context }) => {
  const targetUrl = context.url;
  const snapshots = [];

  async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function getFrame() {
    return page.frames().find(frame => /reyrey\\.net|service-portal/i.test(frame.url()));
  }

  async function snapshot(name, frame) {
    const pageData = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      textSample: (document.body?.innerText || '').slice(0, 1200),
      iframeSources: Array.from(document.querySelectorAll('iframe')).map(f => f.src).filter(Boolean).slice(0, 20)
    }));
    let frameData = null;
    if (frame) {
      try {
        frameData = await frame.evaluate(() => {
          const visible = el => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };
          const fields = Array.from(document.querySelectorAll('input, select, textarea')).map((el, index) => ({
            index,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || '',
            name: el.getAttribute('name') || '',
            id: el.id || '',
            placeholder: el.getAttribute('placeholder') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            value: el.value || '',
            visible: visible(el)
          })).slice(0, 80);
          const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')).map((el, index) => ({
            index,
            text: (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim(),
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            className: String(el.className || '').slice(0, 160),
            href: el.href || '',
            visible: visible(el)
          })).filter(b => b.text || b.href).slice(0, 120);
          return {
            url: location.href,
            title: document.title,
            textSample: (document.body?.innerText || '').slice(0, 3000),
            fields,
            buttons,
            labels: Array.from(document.querySelectorAll('label')).map(el => (el.innerText || '').trim()).filter(Boolean).slice(0, 100)
          };
        });
      } catch (err) {
        frameData = { url: frame.url(), error: err && err.message ? err.message : String(err) };
      }
    }
    snapshots.push({ name, page: pageData, frame: frameData });
  }

  async function clickByText(frame, patterns) {
    return frame.evaluate((patterns) => {
      const regexes = patterns.map(p => new RegExp(p, 'i'));
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
      const target = elements.find(el => {
        const text = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
        return regexes.some(r => r.test(text));
      });
      if (!target) return { clicked: false };
      const text = (target.innerText || target.textContent || target.value || target.getAttribute('aria-label') || '').trim();
      target.click();
      return { clicked: true, text };
    }, patterns);
  }

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000);
    let frame = await getFrame();
    await snapshot('loaded', frame);
    if (!frame) return { data: { ok: false, status: 'reynolds_frame_not_found', snapshots }, type: 'application/json' };

    const scheduleClick = await clickByText(frame, ['schedule appointment']);
    await delay(2500);
    frame = await getFrame();
    await snapshot('after_schedule_appointment', frame);

    const guestClick = await clickByText(frame, ["i.?m new", 'continue as guest', 'guest']);
    await delay(2500);
    frame = await getFrame();
    await snapshot('after_guest_entry', frame);

    return { data: { ok: true, status: 'mapped_guest_entry', scheduleClick, guestClick, snapshots }, type: 'application/json' };
  } catch (err) {
    return { data: { ok: false, status: 'exception', error: err && err.message ? err.message : String(err), snapshots }, type: 'application/json' };
  }
};`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, context: { url: context.url || SCHEDULER_URL } })
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_err) { parsed = { raw: text.slice(0, 4000) }; }
  if (!response.ok) {
    return { ok: false, status: 'browserless_error', http_status: response.status, message: 'Browserless guest flow map failed.', details: parsed };
  }
  return parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
}

async function runSafeFlowSteps(context = {}) {
  if (!BROWSERLESS_API_KEY) {
    return { ok: false, status: 'browserless_not_configured', message: 'BROWSERLESS_API_KEY is not configured on the service.' };
  }
  const steps = Array.isArray(context.steps) ? context.steps.slice(0, 12) : [];
  const forbidden = /\b(book|confirm|submit|finalize|place appointment|complete appointment|schedule it|reserve)\b/i;
  const blockedStep = steps.find(step => forbidden.test(typeof step === 'string' ? step : `${step?.pattern || ''} ${step?.selector || ''}`));
  if (blockedStep) {
    return { ok: false, status: 'blocked_unsafe_step', message: 'Requested step may submit or confirm an appointment.', blockedStep };
  }

  const endpoint = `https://${BROWSERLESS_REGION}/function?token=${encodeURIComponent(BROWSERLESS_API_KEY)}`;
  const code = `
export default async ({ page, context }) => {
  const targetUrl = context.url;
  const steps = context.steps || [];
  const snapshots = [];
  async function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  async function getFrame() { return page.frames().find(frame => /reyrey\\.net|service-portal/i.test(frame.url())); }
  async function snapshot(name, frame) {
    let frameData = null;
    if (frame) {
      try {
        frameData = await frame.evaluate(() => {
          const visible = el => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };
          const fields = Array.from(document.querySelectorAll('input, select, textarea')).map((el, index) => ({
            index,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || '',
            name: el.getAttribute('name') || '',
            id: el.id || '',
            placeholder: el.getAttribute('placeholder') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            value: el.value || '',
            visible: visible(el)
          })).slice(0, 120);
          const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, [tabindex]')).map((el, index) => ({
            index,
            text: (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' '),
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            className: String(el.className || '').slice(0, 180),
            href: el.href || '',
            visible: visible(el)
          })).filter(b => b.text || b.href).slice(0, 180);
          return {
            url: location.href,
            title: document.title,
            textSample: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 3500),
            fields,
            buttons,
            labels: Array.from(document.querySelectorAll('label')).map(el => (el.innerText || '').trim()).filter(Boolean).slice(0, 120)
          };
        });
      } catch (err) { frameData = { url: frame.url(), error: err && err.message ? err.message : String(err) }; }
    }
    snapshots.push({ name, frame: frameData });
  }
  async function clickByText(frame, patternText) {
    return frame.evaluate((patternText) => {
      const re = new RegExp(patternText, 'i');
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, [tabindex]'));
      const target = elements.find(el => {
        const text = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
        if (!text || !re.test(text)) return false;
        const style = window.getComputedStyle(el);
        return style && style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (!target) return { clicked: false, patternText };
      const text = (target.innerText || target.textContent || target.value || target.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return { clicked: true, patternText, text };
    }, patternText);
  }
  async function fillField(frame, selector, value) {
    try {
      await frame.click(selector, { clickCount: 3 });
      await frame.type(selector, String(value), { delay: 25 });
    } catch (_err) {
      // Fallback below handles React-controlled inputs.
    }
    return frame.evaluate(({ selector, value }) => {
      const el = document.querySelector(selector);
      if (!el) return { filled: false, selector, reason: 'not_found' };
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(el, String(value));
      else el.value = String(value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0' }));
      el.blur();
      return { filled: true, selector, value: String(value) };
    }, { selector, value });
  }
  async function checkField(frame, selector, checked = true) {
    try {
      await frame.click(selector);
    } catch (_err) {
      // Fallback below handles direct DOM click.
    }
    return frame.evaluate(({ selector, checked }) => {
      const el = document.querySelector(selector);
      if (!el) return { checked: false, selector, reason: 'not_found' };
      if (Boolean(el.checked) !== Boolean(checked)) el.click();
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { checked: true, selector, value: Boolean(el.checked) };
    }, { selector, checked });
  }
  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000);
    let frame = await getFrame();
    await snapshot('loaded', frame);
    if (!frame) return { data: { ok: false, status: 'reynolds_frame_not_found', snapshots }, type: 'application/json' };
    const clicks = [];
    for (const step of steps) {
      const action = typeof step === 'string' ? { type: 'clickText', pattern: step } : step;
      let result;
      if (!action || action.type === 'clickText') {
        result = await clickByText(frame, action?.pattern || String(step));
      } else if (action.type === 'fill') {
        result = await fillField(frame, action.selector, action.value);
      } else if (action.type === 'check') {
        result = await checkField(frame, action.selector, action.checked !== false);
      } else {
        result = { skipped: true, reason: 'unknown_action_type', action };
      }
      clicks.push({ action, result });
      await delay(action.waitMs || 2500);
      frame = await getFrame();
      const label = (action.pattern || action.selector || action.type || 'step').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
      await snapshot('after_' + label, frame);
      if (result.clicked === false || result.filled === false || result.checked === false) break;
    }
    return { data: { ok: true, status: 'mapped_steps', clicks, snapshots }, type: 'application/json' };
  } catch (err) {
    return { data: { ok: false, status: 'exception', error: err && err.message ? err.message : String(err), snapshots }, type: 'application/json' };
  }
};`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, context: { url: context.url || SCHEDULER_URL, steps } })
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_err) { parsed = { raw: text.slice(0, 4000) }; }
  if (!response.ok) return { ok: false, status: 'browserless_error', http_status: response.status, details: parsed };
  return parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
}

async function runMvpDryRun(context = {}) {
  if (!BROWSERLESS_API_KEY) {
    return { ok: false, status: 'browserless_not_configured', message: 'BROWSERLESS_API_KEY is not configured on the service.' };
  }
  const input = {
    year: String(context.vehicle_year || '2023'),
    model: String(context.vehicle_model || 'CR-V'),
    mileage: String(context.vehicle_mileage || '32000'),
    servicePattern: String(context.service_pattern || 'Oil|Maintenance|Other'),
    transportPattern: String(context.transport_pattern || 'Wait|Drop')
  };
  const endpoint = `https://${BROWSERLESS_REGION}/function?token=${encodeURIComponent(BROWSERLESS_API_KEY)}`;
  const code = `
export default async ({ page, context }) => {
  const snapshots = [];
  async function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  async function getFrame() { return page.frames().find(frame => /reyrey\\.net|service-portal/i.test(frame.url())); }
  async function state(name, frame) {
    if (!frame) { snapshots.push({ name, error: 'no_frame' }); return; }
    const data = await frame.evaluate(() => {
      const compact = s => (s || '').replace(/\\s+/g, ' ').trim();
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, [tabindex]'));
      const buttons = elements.map((el, index) => ({
        index,
        text: compact(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || ''),
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        disabled: Boolean(el.disabled) || /disabled/i.test(String(el.className || ''))
      })).filter(b => b.text).slice(0, 80);
      const fields = Array.from(document.querySelectorAll('input, select, textarea')).map((el, index) => ({
        index,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        id: el.id || '',
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        value: el.value || ''
      })).slice(0, 40);
      return { url: location.href, title: document.title, text: compact(document.body?.innerText || '').slice(0, 1800), buttons, fields };
    });
    snapshots.push({ name, ...data });
  }
  async function clickText(frame, patternText) {
    return frame.evaluate((patternText) => {
      const re = new RegExp(patternText, 'i');
      const els = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, [tabindex]'));
      const target = els.find(el => re.test((el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim()));
      if (!target) return { ok: false, action: 'clickText', patternText };
      const text = (target.innerText || target.textContent || target.value || el.getAttribute?.('aria-label') || '').replace(/\\s+/g, ' ').trim();
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return { ok: true, action: 'clickText', patternText, text };
    }, patternText);
  }
  async function fill(selector, value) {
    try {
      await page.keyboard.press('Tab');
    } catch (_) {}
    const frame = await getFrame();
    try {
      await frame.click(selector, { clickCount: 3 });
      await page.keyboard.type(String(value), { delay: 30 });
    } catch (_) {}
    return frame.evaluate(({ selector, value }) => {
      const el = document.querySelector(selector);
      if (!el) return { ok: false, action: 'fill', selector, reason: 'not_found' };
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(el, String(value)); else el.value = String(value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0' }));
      return { ok: true, action: 'fill', selector, value: String(value), currentValue: el.value };
    }, { selector, value });
  }
  try {
    await page.goto(context.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2500);
    let frame = await getFrame();
    await state('loaded', frame);
    const results = [];
    for (const pattern of ['Schedule Appointment', "I'm new", '^Honda$', '^' + context.year + '$', '^' + context.model + '$']) {
      const r = await clickText(frame, pattern); results.push(r); await delay(1500); frame = await getFrame(); await state('after_' + pattern.replace(/[^a-z0-9]+/gi, '_'), frame); if (!r.ok) return { data: { ok: false, status: 'step_failed', results, snapshots }, type: 'application/json' };
    }
    const fillResult = await fill('#estMileageText_input', context.mileage); results.push(fillResult); await delay(1500); frame = await getFrame(); await state('after_mileage', frame);
    const proceed = await clickText(frame, '^Proceed$'); results.push(proceed); await delay(3000); frame = await getFrame(); await state('after_vehicle_proceed', frame);
    return { data: { ok: true, status: 'mvp_dry_run_vehicle_complete', results, snapshots }, type: 'application/json' };
  } catch (err) {
    return { data: { ok: false, status: 'exception', error: err && err.message ? err.message : String(err), snapshots }, type: 'application/json' };
  }
};`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, context: { url: SCHEDULER_URL, ...input } })
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_err) { parsed = { raw: text.slice(0, 4000) }; }
  if (!response.ok) return { ok: false, status: 'browserless_error', http_status: response.status, details: parsed };
  return parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
}

async function runFinalStateMap(context = {}) {
  if (!BROWSERLESS_API_KEY) {
    return { ok: false, status: 'browserless_not_configured', message: 'BROWSERLESS_API_KEY is not configured on the service.' };
  }
  const steps = Array.isArray(context.steps) ? context.steps.slice(0, 15) : [];
  const forbidden = /\b(book|confirm|submit|finalize|place appointment|complete appointment|schedule it|reserve)\b/i;
  const blockedStep = steps.find(step => forbidden.test(typeof step === 'string' ? step : `${step?.pattern || ''} ${step?.selector || ''}`));
  if (blockedStep) return { ok: false, status: 'blocked_unsafe_step', blockedStep };

  const endpoint = `https://${BROWSERLESS_REGION}/function?token=${encodeURIComponent(BROWSERLESS_API_KEY)}`;
  const code = `
export default async ({ page, context }) => {
  const targetUrl = context.url;
  const steps = context.steps || [];
  async function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  async function getFrame() { return page.frames().find(frame => /reyrey\\.net|service-portal/i.test(frame.url())); }
  async function compactState(frame) {
    if (!frame) return { error: 'no_frame' };
    return frame.evaluate(() => {
      const compact = s => (s || '').replace(/\\s+/g, ' ').trim();
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, [tabindex]'));
      const buttons = elements.map((el, index) => ({
        index,
        text: compact(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || ''),
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        disabled: Boolean(el.disabled) || /disabled/i.test(String(el.className || ''))
      })).filter(b => b.text).slice(0, 120);
      const fields = Array.from(document.querySelectorAll('input, select, textarea')).map((el, index) => ({
        index,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        id: el.id || '',
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        value: el.value || '',
        checked: Boolean(el.checked)
      })).slice(0, 60);
      return { url: location.href, title: document.title, text: compact(document.body?.innerText || '').slice(0, 2500), fields, buttons };
    });
  }
  async function clickText(frame, patternText) {
    return frame.evaluate((patternText) => {
      const re = new RegExp(patternText, 'i');
      const els = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, [tabindex]'));
      const target = els.find(el => re.test((el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim()));
      if (!target) return { ok: false, action: 'clickText', patternText };
      const text = (target.innerText || target.textContent || target.value || target.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      target.scrollIntoView({ block: 'center', inline: 'center' }); target.click();
      return { ok: true, action: 'clickText', patternText, text };
    }, patternText);
  }
  async function fill(frame, selector, value) {
    try { await frame.click(selector, { clickCount: 3 }); await page.keyboard.type(String(value), { delay: 20 }); } catch (_) {}
    return frame.evaluate(({ selector, value }) => {
      const el = document.querySelector(selector);
      if (!el) return { ok: false, action: 'fill', selector, reason: 'not_found' };
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(el, String(value)); else el.value = String(value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: String(value).slice(-1) || '0' }));
      return { ok: true, action: 'fill', selector, value: String(value), currentValue: el.value };
    }, { selector, value });
  }
  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2500);
    let frame = await getFrame();
    const results = [];
    for (const step of steps) {
      const action = typeof step === 'string' ? { type: 'clickText', pattern: step } : step;
      let result;
      if (action.type === 'clickText') result = await clickText(frame, action.pattern);
      else if (action.type === 'fill') result = await fill(frame, action.selector, action.value);
      else result = { ok: false, reason: 'unknown_action', action };
      results.push({ action, result });
      await delay(action.waitMs || 1800);
      frame = await getFrame();
      if (result.ok === false) break;
    }
    const finalState = await compactState(frame);
    return { data: { ok: true, status: 'final_state_mapped', results, finalState }, type: 'application/json' };
  } catch (err) {
    return { data: { ok: false, status: 'exception', error: err && err.message ? err.message : String(err) }, type: 'application/json' };
  }
};`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, context: { url: SCHEDULER_URL, steps } })
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_err) { parsed = { raw: text.slice(0, 4000) }; }
  if (!response.ok) return { ok: false, status: 'browserless_error', http_status: response.status, details: parsed };
  return parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
}

async function runNextState(context = {}) {
  if (!BROWSERLESS_API_KEY) {
    return { ok: false, status: 'browserless_not_configured', message: 'BROWSERLESS_API_KEY is not configured on the service.' };
  }
  const steps = Array.isArray(context.steps) ? context.steps.slice(0, 15) : [];
  const forbidden = /\b(book|confirm|submit|finalize|place appointment|complete appointment|schedule it|reserve)\b/i;
  const blockedStep = steps.find(step => forbidden.test(typeof step === 'string' ? step : `${step?.pattern || ''} ${step?.selector || ''}`));
  if (blockedStep) return { ok: false, status: 'blocked_unsafe_step', blockedStep };
  const endpoint = `https://${BROWSERLESS_REGION}/function?token=${encodeURIComponent(BROWSERLESS_API_KEY)}`;
  const stepsJson = JSON.stringify(steps);
  const targetUrlJson = JSON.stringify(SCHEDULER_URL);
  const code = `
export default async ({ page }) => {
  const targetUrl = ${targetUrlJson};
  const steps = ${stepsJson};
  async function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  async function getFrame() { return page.frames().find(frame => /reyrey\\.net|service-portal/i.test(frame.url())); }
  async function state(frame) {
    if (!frame) return { error: 'no_frame' };
    return frame.evaluate(() => {
      const compact = s => (s || '').replace(/\\s+/g, ' ').trim();
      const fields = Array.from(document.querySelectorAll('input, select, textarea')).map((el, index) => ({
        index, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', id: el.id || '', name: el.getAttribute('name') || '', placeholder: el.getAttribute('placeholder') || '', value: el.value || '', checked: Boolean(el.checked)
      })).slice(0, 50);
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, [tabindex]')).map((el, index) => ({
        index, text: compact(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || ''), tag: el.tagName.toLowerCase(), id: el.id || '', disabled: Boolean(el.disabled) || /disabled/i.test(String(el.className || ''))
      })).filter(b => b.text).slice(0, 100);
      return { url: location.href, title: document.title, text: compact(document.body?.innerText || '').slice(0, 2500), fields, buttons };
    });
  }
  async function clickText(frame, patternText, pick = 'shortest') {
    return frame.evaluate(({ patternText, pick }) => {
      const re = new RegExp(patternText, 'i');
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, label, div, span, p, h1, h2, h3, h4, [tabindex]'));
      const matches = candidates.map(el => {
        const text = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        const clickable = el.matches('button, a, [role="button"], input[type="button"], input[type="submit"], li, label, [tabindex]')
          ? el
          : el.closest('button, a, [role="button"], li, label, [tabindex]');
        const clickText = clickable ? (clickable.innerText || clickable.textContent || clickable.value || clickable.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim() : text;
        const style = clickable ? window.getComputedStyle(clickable) : window.getComputedStyle(el);
        const rect = clickable ? clickable.getBoundingClientRect() : el.getBoundingClientRect();
        const disabled = Boolean(clickable?.disabled) || /disabled/i.test(String(clickable?.className || '')) || clickable?.getAttribute('aria-disabled') === 'true';
        const visible = style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        return { el: clickable || el, text, clickText, disabled, visible, score: text.length };
      }).filter(item => item.text && re.test(item.text));
      const enabledMatches = matches.filter(item => !item.disabled);
      const visibleEnabled = enabledMatches.filter(item => item.visible);
      let pool = visibleEnabled.length ? visibleEnabled : enabledMatches.length ? enabledMatches : matches;
      if (pick === 'last') pool = pool.slice().reverse();
      else if (pick === 'shortest') pool = pool.slice().sort((a, b) => a.score - b.score);
      const targetInfo = pool[0];
      if (!targetInfo) return { ok: false, type: 'clickText', patternText, pick };
      targetInfo.el.scrollIntoView({ block: 'center', inline: 'center' });
      targetInfo.el.click();
      return { ok: true, type: 'clickText', patternText, pick, text: targetInfo.text, clickedText: targetInfo.clickText, disabled: targetInfo.disabled, visible: targetInfo.visible, matchCount: matches.length, selectedTextLength: targetInfo.score };
    }, { patternText, pick });
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
    await delay(2500);
    let frame = await getFrame();
    const results = [];
    for (const step of steps) {
      const action = typeof step === 'string' ? { type: 'clickText', pattern: step } : step;
      let result;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (action.type === 'clickText') result = await clickText(frame, action.pattern, action.pick || 'shortest');
        else if (action.type === 'fill') result = await fill(frame, action.selector, action.value);
        else if (action.type === 'clickSelector') result = await clickSelector(frame, action.selector, action.index || 0);
        else result = { ok: false, reason: 'unknown_action', action };
        if (result.ok !== false) break;
        await delay(1000);
        frame = await getFrame();
      }
      results.push({ action, result });
      await delay(action.waitMs || 1400);
      frame = await getFrame();
      if (result.ok === false) break;
    }
    return { data: { ok: true, status: 'next_state', results, finalState: await state(frame) }, type: 'application/json' };
  } catch (err) {
    return { data: { ok: false, status: 'exception', error: err && err.message ? err.message : String(err) }, type: 'application/json' };
  }
};`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, context: { url: SCHEDULER_URL, steps } })
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_err) { parsed = { raw: text.slice(0, 4000) }; }
  if (!response.ok) return { ok: false, status: 'browserless_error', http_status: response.status, details: parsed };
  return parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
}

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
  const probe = await runBrowserlessProbe({ url: input.scheduler_url || SCHEDULER_URL });
  return {
    success: false,
    status: probe.ok ? 'live_dry_run_validated_no_submit' : 'portal_probe_failed',
    confirmation_number: null,
    date: input.preferred_date,
    time: normalizeTime(input.preferred_time),
    message: probe.ok
      ? 'Browserless reached the Brandon Honda scheduling page, but live final submission is disabled until the Reynolds flow is fully mapped and ALLOW_LIVE_SUBMIT is enabled.'
      : 'Browserless could not validate the Brandon Honda scheduling page. Transfer caller to the Brandon Honda service team.',
    available_slots: nearestDemoSlots(input.preferred_date),
    proof_url: null,
    dealer: DEALER_NAME,
    address: DEALER_ADDRESS,
    portal_probe: {
      ok: Boolean(probe.ok),
      status: probe.status || null,
      finalUrl: probe.finalUrl || null,
      title: probe.title || null,
      iframeCount: probe.iframeCount || 0,
      inputCount: probe.inputCount || 0,
      hasSchedulerCopy: Boolean(probe.hasSchedulerCopy),
      hasAppointmentCopy: Boolean(probe.hasAppointmentCopy),
      hasReynoldsFrame: Boolean(probe.reynoldsFrame),
      reynoldsFrameUrl: probe.reynoldsFrame?.url || null,
      reynoldsStartClicked: Boolean(probe.reynoldsStartClicked)
    },
    live_submit_enabled: ALLOW_LIVE_SUBMIT
  };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'brandon-honda-booking-service',
    mode: MODE,
    browserlessConfigured: Boolean(BROWSERLESS_API_KEY),
    liveSubmitEnabled: ALLOW_LIVE_SUBMIT
  });
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

app.get('/portal-probe', async (_req, res) => {
  const probe = await runBrowserlessProbe({ url: SCHEDULER_URL });
  res.status(probe.ok ? 200 : 502).json(probe);
});

app.post('/portal-probe', requireAuth, async (req, res) => {
  const probe = await runBrowserlessProbe({ url: req.body?.url || SCHEDULER_URL });
  res.status(probe.ok ? 200 : 502).json(probe);
});

app.get('/validate-process', async (_req, res) => {
  const probe = await runBrowserlessProbe({ url: SCHEDULER_URL });
  const sampleBooking = await bookWithPortal({
    call_id: 'validation-call',
    preferred_date: '09/05/2026',
    preferred_time: '09:30',
    scheduler_url: SCHEDULER_URL
  });
  res.status(probe.ok ? 200 : 502).json({
    ok: Boolean(probe.ok),
    mode: MODE,
    browserlessConfigured: Boolean(BROWSERLESS_API_KEY),
    liveSubmitEnabled: ALLOW_LIVE_SUBMIT,
    portal: {
      reachedOuterPage: Boolean(probe.ok),
      title: probe.title || null,
      iframeCount: probe.iframeCount || 0,
      reynoldsFrameUrl: probe.reynoldsFrame?.url || null,
      reynoldsFrameTitle: probe.reynoldsFrame?.title || null,
      reynoldsStartClicked: Boolean(probe.reynoldsStartClicked),
      afterStartTextSample: probe.reynoldsAfterStart?.textSample?.slice(0, 1000) || null
    },
    bookingDryRun: {
      success: sampleBooking.success,
      status: sampleBooking.status,
      message: sampleBooking.message,
      confirmation_number: sampleBooking.confirmation_number,
      live_submit_enabled: sampleBooking.live_submit_enabled ?? ALLOW_LIVE_SUBMIT
    }
  });
});

app.get('/map-guest-flow', async (_req, res) => {
  const result = await runGuestFlowMap({ url: SCHEDULER_URL });
  res.status(result.ok ? 200 : 502).json(result);
});

app.post('/map-flow', async (req, res) => {
  const result = await runSafeFlowSteps({ url: SCHEDULER_URL, steps: req.body?.steps || [] });
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/mvp-dry-run', async (req, res) => {
  const result = await runMvpDryRun(req.body || {});
  res.status(result.ok ? 200 : 502).json(result);
});

app.post('/map-final-state', async (req, res) => {
  const result = await runFinalStateMap(req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/next-state', async (req, res) => {
  const result = await runNextState(req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
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
