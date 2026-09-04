import { chromium } from 'playwright-core';
import crypto from 'crypto';

const sessions = new Map();
const DEFAULT_URL = 'https://r7699369.m.reyrey.net/service-portal/?token=FE1B2C28E80E4182A2084EA7EAAEE51C';
const DEFAULT_CLICK_TIMEOUT_MS = 15000;
const FIRST_CLICK_TIMEOUT_MS = 30000;

function wsEndpoint() {
  const token = process.env.BROWSERLESS_API_KEY;
  const region = process.env.BROWSERLESS_REGION || 'production-sfo.browserless.io';
  if (!token) throw new Error('BROWSERLESS_API_KEY is not configured');
  return `wss://${region}/chromium?token=${encodeURIComponent(token)}&timeout=300000&blockAds=true`;
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializeError(err) {
  return {
    name: err?.name || 'Error',
    message: err?.message || String(err),
    stack: err?.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined
  };
}

async function getReynoldsFrame(page) {
  for (let i = 0; i < 40; i++) {
    const frame = page.frames().find(f => /reyrey\.net|service-portal/i.test(f.url()));
    if (frame) return frame;
    await page.waitForLoadState('domcontentloaded', { timeout: 500 }).catch(() => {});
  }
  throw new Error('Reynolds iframe not found');
}

async function snapshot(page) {
  const frame = await getReynoldsFrame(page);
  const state = await frame.evaluate(() => {
    const compact = s => (s || '').replace(/\s+/g, ' ').trim();
    const fields = Array.from(document.querySelectorAll('input, select, textarea')).map((el, index) => {
      const r = el.getBoundingClientRect();
      return {
        index,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        id: el.id || '',
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        value: el.value || '',
        checked: Boolean(el.checked),
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
        visible: r.width > 0 && r.height > 0
      };
    }).slice(0, 120);
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], li, label, [tabindex]')).map((el, index) => {
      const r = el.getBoundingClientRect();
      return {
        index,
        text: compact(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || ''),
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        disabled: Boolean(el.disabled) || /disabled/i.test(String(el.className || '')) || el.getAttribute('aria-disabled') === 'true',
        visible: r.width > 0 && r.height > 0
      };
    }).filter(c => c.text).slice(0, 200);
    return {
      url: location.href,
      title: document.title,
      text: compact(document.body?.innerText || '').slice(0, 6000),
      fields,
      controls
    };
  });
  return state;
}

async function findControl(frame, pattern, { pick = 'shortest' } = {}) {
  const re = new RegExp(pattern, 'i');
  const roleButtons = frame.getByRole('button', { name: re });
  const buttonCount = await roleButtons.count().catch(() => 0);
  const roleCandidates = [];
  for (let i = 0; i < buttonCount; i++) {
    const loc = roleButtons.nth(i);
    const text = ((await loc.innerText().catch(async () => await loc.getAttribute('aria-label').catch(() => '') || '')) || '').replace(/\s+/g, ' ').trim();
    const visible = await loc.isVisible().catch(() => false);
    const enabled = await loc.isEnabled().catch(() => true);
    roleCandidates.push({ loc, text, visible, enabled, score: text.length, index: i, strategy: 'role:button' });
  }
  let rolePool = roleCandidates.filter(c => c.visible && c.enabled);
  if (rolePool.length) {
    if (pick === 'last') return rolePool[rolePool.length - 1];
    if (pick === 'first') return rolePool[0];
    return rolePool.sort((a, b) => a.score - b.score)[0];
  }

  const controls = frame.locator('button, a, [role="button"], input[type="button"], input[type="submit"], li, label, [tabindex]').filter({ hasText: re });
  const count = await controls.count();
  const candidates = [...roleCandidates];
  if (!count && !candidates.length) return null;
  for (let i = 0; i < count; i++) {
    const loc = controls.nth(i);
    const text = ((await loc.innerText().catch(async () => await loc.getAttribute('aria-label').catch(() => '') || '')) || '').replace(/\s+/g, ' ').trim();
    const visible = await loc.isVisible().catch(() => false);
    const enabled = await loc.isEnabled().catch(() => true);
    candidates.push({ loc, text, visible, enabled, score: text.length, index: i, strategy: 'generic' });
  }
  const pool = candidates.filter(c => c.visible && c.enabled);
  if (!pool.length) {
    return { error: 'no_visible_enabled_match', candidates: candidates.map(({ loc, ...rest }) => rest).slice(0, 20) };
  }
  if (pick === 'last') return pool[pool.length - 1];
  if (pick === 'first') return pool[0];
  return pool.sort((a, b) => a.score - b.score)[0];
}

async function clickText(frame, pattern, opts = {}) {
  const candidate = await findControl(frame, pattern, opts);
  if (!candidate) return { ok: false, type: 'clickText', pattern, reason: 'not_found' };
  if (candidate.error) return { ok: false, type: 'clickText', pattern, reason: candidate.error, candidates: candidate.candidates };
  try {
    await candidate.loc.click({ timeout: opts.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS });
    return { ok: true, type: 'clickText', pattern, text: candidate.text, index: candidate.index, visible: candidate.visible, enabled: candidate.enabled };
  } catch (err) {
    if (opts.acceptIfTextAppears) {
      const expected = String(opts.acceptIfTextAppears).toLowerCase();
      await frame.page().waitForFunction(
        value => document.body?.innerText?.toLowerCase().includes(value),
        expected,
        { timeout: opts.postClickSettleMs || 1500 }
      ).catch(() => {});
      const bodyText = await frame.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
      if (bodyText.toLowerCase().includes(expected)) {
        return { ok: true, type: 'clickText', pattern, text: candidate.text, index: candidate.index, visible: candidate.visible, enabled: candidate.enabled, warning: 'click_failed_but_expected_text_appeared', expectedText: opts.acceptIfTextAppears, error: serializeError(err) };
      }
    }
    return { ok: false, type: 'clickText', pattern, reason: 'click_failed', target: { text: candidate.text, index: candidate.index, visible: candidate.visible, enabled: candidate.enabled }, error: serializeError(err) };
  }
}

async function clickSelector(frame, selector, index = 0, opts = {}) {
  const loc = frame.locator(selector).nth(index);
  const count = await frame.locator(selector).count();
  if (!count || index >= count) return { ok: false, type: 'clickSelector', selector, index, count, reason: 'not_found' };
  try {
    await loc.click({ timeout: opts.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS });
    const checked = await loc.isChecked().catch(() => false);
    return { ok: true, type: 'clickSelector', selector, index, count, checked };
  } catch (err) {
    return { ok: false, type: 'clickSelector', selector, index, count, reason: 'click_failed', error: serializeError(err) };
  }
}

async function clickNearbyInput(frame, pattern, inputType = 'checkbox') {
  const textLoc = frame.locator('div, span, p, label, button, li').filter({ hasText: new RegExp(pattern, 'i') });
  const count = await textLoc.count();
  for (let i = 0; i < count; i++) {
    const loc = textLoc.nth(i);
    const input = loc.locator(`input[type="${inputType}"]`).first();
    if (await input.count()) {
      try {
        await input.click({ timeout: DEFAULT_CLICK_TIMEOUT_MS });
        return { ok: true, type: 'clickNearbyInput', pattern, inputType, textIndex: i, checked: await input.isChecked().catch(() => false) };
      } catch (err) {
        return { ok: false, type: 'clickNearbyInput', pattern, inputType, textIndex: i, reason: 'click_failed', error: serializeError(err) };
      }
    }
  }
  return { ok: false, type: 'clickNearbyInput', pattern, inputType, reason: 'not_found' };
}

async function fill(frame, selector, value) {
  const loc = frame.locator(selector).first();
  if (!(await loc.count())) return { ok: false, type: 'fill', selector, reason: 'not_found' };
  try {
    await loc.fill(String(value), { timeout: 10000 });
    return { ok: true, type: 'fill', selector, value: String(value) };
  } catch (err) {
    return { ok: false, type: 'fill', selector, value: String(value), reason: 'fill_failed', error: serializeError(err) };
  }
}

async function clickTimeInTransportRow(frame, transport, time, opts = {}) {
  const marker = `kafka-slot-${crypto.randomUUID()}`;
  const found = await frame.evaluate(({ transport, time, marker }) => {
    const compact = s => (s || '').replace(/\s+/g, ' ').trim();
    const norm = s => compact(s).toLowerCase();
    const isVisible = el => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const isDisabled = el => Boolean(el.disabled) || /disabled/i.test(String(el.className || '')) || el.getAttribute('aria-disabled') === 'true';
    const desiredTransport = norm(transport);
    const desiredTime = norm(time);
    const knownTransportLabels = [
      'i am dropping off my vehicle',
      'i am leaving my vehicle after hours',
      'i am waiting with my vehicle',
      'i will take the shuttle'
    ];
    const controls = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a, li, label'));
    const visibleControls = controls.map((el, index) => ({ el, index, text: compact(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || ''), visible: isVisible(el), disabled: isDisabled(el) }))
      .filter(item => item.text && item.visible && !item.disabled);
    const labelElements = Array.from(document.querySelectorAll('button, [role="button"], a, li, label, div, span, p'))
      .map((el, index) => ({ el, index, text: compact(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || ''), visible: isVisible(el), disabled: isDisabled(el) }))
      .filter(item => item.text && item.visible && !item.disabled && item.text.length <= 1600);
    const rowLabels = labelElements
      .filter(item => norm(item.text).includes(desiredTransport))
      .map(item => ({ ...item, otherTransportCount: knownTransportLabels.filter(label => label !== desiredTransport && norm(item.text).includes(label)).length }))
      .sort((a, b) => a.otherTransportCount - b.otherTransportCount || a.text.length - b.text.length);
    const allTimeMatches = visibleControls.filter(item => norm(item.text) === desiredTime);
    const attempts = [];

    function ancestorChain(el, maxDepth = 10) {
      const out = [];
      let node = el;
      for (let depth = 0; node && depth <= maxDepth; depth++, node = node.parentElement) out.push(node);
      return out;
    }

    function visibleTimeButtonsWithin(root) {
      return Array.from(root.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a'))
        .filter(el => compact(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase() === desiredTime)
        .filter(el => isVisible(el) && !isDisabled(el));
    }

    for (const rowLabel of rowLabels) {
      const chain = ancestorChain(rowLabel.el, 10);
      for (const ancestor of chain) {
        const rect = ancestor.getBoundingClientRect();
        const ancestorText = compact(ancestor.innerText || ancestor.textContent || '');
        if (!ancestorText || !norm(ancestorText).includes(desiredTransport)) continue;
        const timeButtons = visibleTimeButtonsWithin(ancestor);
        attempts.push({ rowLabel: rowLabel.text, ancestorTag: ancestor.tagName.toLowerCase(), ancestorText: ancestorText.slice(0, 300), w: rect.width, h: rect.height, timeCount: timeButtons.length });
        if (timeButtons.length) {
          const target = timeButtons[0];
          target.setAttribute('data-kafka-slot-target', marker);
          return { ok: true, marker, transportMatched: rowLabel.text, timeMatched: compact(target.innerText || target.textContent || target.value || target.getAttribute('aria-label') || ''), attempts: attempts.slice(0, 20), allTimeMatchCount: allTimeMatches.length };
        }
      }
    }
    return { ok: false, reason: 'transport_time_not_found', transport, time, rowLabels: rowLabels.map(x => x.text), allTimeMatchCount: allTimeMatches.length, attempts: attempts.slice(0, 20) };
  }, { transport, time, marker });

  if (!found.ok) return { type: 'clickTimeInTransportRow', ...found };
  try {
    await frame.locator(`[data-kafka-slot-target="${marker}"]`).click({ timeout: opts.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS });
    await frame.evaluate(marker => {
      document.querySelectorAll(`[data-kafka-slot-target="${marker}"]`).forEach(el => el.removeAttribute('data-kafka-slot-target'));
    }, marker).catch(() => {});
    return { ok: true, type: 'clickTimeInTransportRow', transportRequested: transport, transportMatched: found.transportMatched, timeRequested: time, timeMatched: found.timeMatched, allTimeMatchCount: found.allTimeMatchCount, attempts: found.attempts };
  } catch (err) {
    await frame.evaluate(marker => {
      document.querySelectorAll(`[data-kafka-slot-target="${marker}"]`).forEach(el => el.removeAttribute('data-kafka-slot-target'));
    }, marker).catch(() => {});
    return { ok: false, type: 'clickTimeInTransportRow', reason: 'click_failed', transportRequested: transport, timeRequested: time, found, error: serializeError(err) };
  }
}

const TIME_RE = /^(0?\d|1[0-2]):[0-5]\d\s?(am|pm)$/i;
const AFTER_HOURS_LABEL = 'i am leaving my vehicle after hours';
const AFTER_HOURS_SLOT = 'Before 06:00am';

// Lists the visible, enabled time buttons that sit inside the requested transport row.
// Same ancestor-walk as clickTimeInTransportRow, so a slot returned here is a slot that
// clickTimeInTransportRow can later click for the same row.
async function listTimesInTransportRow(frame, transport) {
  return frame.evaluate(({ transport }) => {
    const compact = s => (s || '').replace(/\s+/g, ' ').trim();
    const norm = s => compact(s).toLowerCase();
    const timeRe = /^(0?\d|1[0-2]):[0-5]\d\s?(am|pm)$/i;
    const isVisible = el => { const r = el.getBoundingClientRect(); const st = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'; };
    const isDisabled = el => Boolean(el.disabled) || /disabled/i.test(String(el.className || '')) || el.getAttribute('aria-disabled') === 'true';
    const known = ['i am dropping off my vehicle', 'i am leaving my vehicle after hours', 'i am waiting with my vehicle', 'i will take the shuttle'];
    const desired = norm(transport).replace(/\.$/, '');
    const timesWithin = root => Array.from(root.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a, li'))
      .filter(el => isVisible(el) && !isDisabled(el))
      .map(el => compact(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || ''))
      .filter(t => timeRe.test(t) || /^before 0?6:00\s?am$/i.test(t));
    const labels = Array.from(document.querySelectorAll('button, [role="button"], a, li, label, div, span, p, h1, h2, h3, h4'))
      .map(el => ({ el, text: compact(el.innerText || el.textContent || '') }))
      .filter(x => x.text && x.text.length <= 1600 && isVisible(x.el) && norm(x.text).includes(desired))
      .map(x => ({ ...x, others: known.filter(k => k !== desired && norm(x.text).includes(k)).length }))
      .sort((a, b) => a.others - b.others || a.text.length - b.text.length);
    const allRows = known.filter(k => norm(document.body.innerText || '').includes(k));
    const allTimes = timesWithin(document.body);
    for (const label of labels) {
      let node = label.el;
      for (let depth = 0; node && depth <= 10; depth++, node = node.parentElement) {
        const t = norm(node.innerText || node.textContent || '');
        if (!t.includes(desired)) continue;
        // stop before an ancestor that also contains another transport row: that is the whole grid
        if (known.some(k => k !== desired && t.includes(k))) break;
        const times = Array.from(new Set(timesWithin(node)));
        if (times.length) return { ok: true, transportMatched: label.text, times, rowsOnScreen: allRows, allTimeCount: allTimes.length };
      }
    }
    return { ok: false, reason: labels.length ? 'row_found_no_times' : 'transport_row_not_found', transport, rowsOnScreen: allRows, allTimeCount: allTimes.length, sampleTimes: allTimes.slice(0, 8) };
  }, { transport });
}

function parseUsDate(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return { month: Number(m[1]), day: Number(m[2]), year: Number(m[3]) };
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Walks a warm session from wherever it is to the time grid for the requested date and
// transport row, and returns the open times. Read-only: it never reaches the review screen
// and never touches ADD APPOINTMENT. Leaves the session on the time screen so a later
// /book-service call can continue from there.
export async function collectAvailability(sessionId, input = {}) {
  const trace = [];
  const t0 = Date.now();
  let session = sessions.get(sessionId);
  let startedHere = false;
  if (!session) {
    const started = await startSession({});
    if (!started.ok) return { ok: false, status: 'session_start_failed', error: started.error, trace };
    session = sessions.get(started.id);
    startedHere = true;
  }
  session.lastUsedAt = Date.now();
  const page = session.page;
  const date = parseUsDate(input.preferred_date);
  if (!date) return { ok: false, status: 'bad_date', message: 'preferred_date must be MM/DD/YYYY', session_id: session.id, trace };
  const transport = String(input.transport_option || input.transportation_plan || 'I am dropping off my vehicle.');
  const isAfterHours = transport.toLowerCase().includes(AFTER_HOURS_LABEL);
  const modelLabel = String(input.vehicle_model || '').trim();
  const year = String(input.vehicle_year || '').trim();
  const mileage = String(input.vehicle_mileage || '').replace(/[^\d]/g, '');
  const serviceLabel = String(input.service_label || '').trim();
  const freeText = String(input.service_free_text || input.service_concern || '').trim();

  const text = async () => (await getReynoldsFrame(page)).evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
  const has = (t, needle) => t.toLowerCase().includes(String(needle).toLowerCase());
  const note = (screen, detail) => trace.push({ t: Date.now() - t0, screen, ...detail });

  // click, then insist the screen actually changed (both first clicks are known to swallow a click)
  async function clickUntil(step, expectText, { absent = false, attempts = 6, waitMs = 1500 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const r = await applyStep(page, step);
      await page.waitForFunction(({ expected, absent }) => {
        const t = (document.body?.innerText || '').toLowerCase();
        return absent ? !t.includes(expected) : t.includes(expected);
      }, { expected: String(expectText).toLowerCase(), absent }, { timeout: waitMs }).catch(() => {});
      const t = await text();
      const ok = absent ? !has(t, expectText) : has(t, expectText);
      if (ok) { note(step.pattern || step.selector || step.type, { attempt: i + 1, result: r.ok }); return true; }
      if (r.ok === false && r.reason === 'not_found' && i >= 1) break;
    }
    note(step.pattern || step.selector || step.type, { failed: true, lastText: (await text()).slice(0, 400) });
    return false;
  }

  try {
    let t = await text();
    // 1. entry
    if (has(t, 'Schedule your service appointment') && !has(t, "I'M NEW") && !has(t, 'Select Your Make')) {
      if (!await clickUntil({ type: 'clickText', pattern: 'Schedule Appointment', pick: 'shortest', firstClick: true }, "I'M NEW")) return fail('entry_failed');
    }
    t = await text();
    if (has(t, "I'M NEW") && !has(t, 'Select Your Make')) {
      if (!await clickUntil({ type: 'clickText', pattern: "^I'M NEW$", pick: 'shortest', firstClick: true }, 'Select Your Make')) return fail('guest_entry_failed');
    }
    // 2. vehicle
    t = await text();
    if (has(t, 'Select Your Make')) {
      if (!await clickUntil({ type: 'clickText', pattern: '^Honda$' }, 'Select Your Make', { absent: true, waitMs: 1200 }) && !has(await text(), year)) return fail('make_failed');
      if (!await clickUntil({ type: 'clickText', pattern: '^' + escapeRegex(year) + '$' }, 'Estimated Mileage', { attempts: 2, waitMs: 800 })) {
        // year click shows the model list; the model click shows mileage
        if (!await clickUntil({ type: 'clickText', pattern: '^' + escapeRegex(modelLabel) + '$' }, 'Estimated Mileage')) return fail('model_not_available_for_year', { year, model: modelLabel });
      }
    }
    // 3. mileage + PROCEED (second known click race)
    t = await text();
    if (has(t, 'Estimated Mileage')) {
      if (mileage) await applyStep(page, { type: 'fill', selector: '#estMileageText_input', value: mileage });
      else await applyStep(page, { type: 'clickSelector', selector: '#estMilCheckbox' });
      if (!await clickUntil({ type: 'clickText', pattern: '^PROCEED$', pick: 'last' }, 'Estimated Mileage', { absent: true })) return fail('mileage_proceed_failed');
    }
    // 4. service: exact label checkbox, or TELL US free text
    t = await text();
    const onService = has(t, 'TELL US') || has(t, 'OIL CHANGE') || has(t, 'RECALL');
    if (onService) {
      if (serviceLabel && serviceLabel.toUpperCase() !== 'TELL US') {
        const r = await applyStep(page, { type: 'clickNearbyInput', pattern: '^' + escapeRegex(serviceLabel) + '$' });
        note('service_label', { label: serviceLabel, ok: r.ok, reason: r.reason });
        if (r.ok === false) return fail('service_label_not_found', { label: serviceLabel });
      } else {
        const r1 = await applyStep(page, { type: 'clickText', pattern: 'TELL US', pick: 'shortest' });
        const r2 = await applyStep(page, { type: 'fill', selector: 'textarea', value: freeText || 'Customer request, see notes' });
        note('service_tell_us', { tab: r1.ok, filled: r2.ok, reason: r2.reason });
        if (r2.ok === false) return fail('tell_us_textarea_not_found');
      }
      if (!await clickUntil({ type: 'clickText', pattern: '^PROCEED$', pick: 'last' }, 'TELL US', { absent: true })) return fail('service_proceed_failed');
    }
    // 5. adaptive walk: advisor -> date -> time grid (screen order confirmed at runtime; see trace)
    for (let hop = 0; hop < 8; hop++) {
      const frame = await getReynoldsFrame(page);
      const st = await snapshot(page);
      const body = st.text || '';
      const ctl = (st.controls || []).filter(c => c.visible && !c.disabled);
      // time grid reached?
      const timesVisible = ctl.filter(c => TIME_RE.test(c.text) || /^before 0?6:00\s?am$/i.test(c.text));
      if (timesVisible.length) {
        if (isAfterHours) {
          const row = await listTimesInTransportRow(frame, transport);
          note('time_grid', { afterHours: true, row: row.ok, rowsOnScreen: row.rowsOnScreen });
          return done(row.ok ? [AFTER_HOURS_SLOT] : [], row);
        }
        const row = await listTimesInTransportRow(frame, transport);
        note('time_grid', { rowOk: row.ok, reason: row.reason, count: row.times ? row.times.length : 0, rowsOnScreen: row.rowsOnScreen, allTimeCount: row.allTimeCount });
        if (!row.ok) return fail('transport_row_not_found', { detail: row });
        return done(row.times, row);
      }
      // advisor screen
      const anyAdvisor = ctl.find(c => /any advisor/i.test(c.text));
      if (anyAdvisor) {
        await applyStep(page, { type: 'clickText', pattern: 'ANY ADVISOR', pick: 'shortest' });
        note('advisor', { clicked: true });
        const proceed = ctl.find(c => /^PROCEED$/i.test(c.text));
        if (proceed) await applyStep(page, { type: 'clickText', pattern: '^PROCEED$', pick: 'last' });
        await page.waitForTimeout(800);
        continue;
      }
      // date screen: a month header plus day-number buttons, or a date input
      const dateInput = (st.fields || []).find(f => f.visible && (f.type === 'date' || /date/i.test(f.id + f.name + f.placeholder)));
      const dayButtons = ctl.filter(c => /^\d{1,2}$/.test(c.text));
      const monthShown = MONTHS.findIndex(m => body.toLowerCase().includes(m));
      if (dateInput || dayButtons.length >= 20) {
        note('date_screen', { dateInput: dateInput ? dateInput.id : null, dayButtons: dayButtons.length, monthShown: monthShown >= 0 ? MONTHS[monthShown] : null });
        if (dateInput) {
          const iso = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
          await applyStep(page, { type: 'fill', selector: dateInput.id ? '#' + dateInput.id : 'input[type="date"]', value: iso });
        } else {
          // advance months until the header matches
          for (let m = 0; m < 6 && monthShown >= 0; m++) {
            const nowText = (await text()).toLowerCase();
            const cur = MONTHS.findIndex(mm => nowText.includes(mm));
            if (cur === date.month - 1) break;
            const r = await applyStep(page, { type: 'clickText', pattern: '(next|›|>|chevron_right|arrow_forward)', pick: 'shortest' });
            note('calendar_next', { ok: r.ok, reason: r.reason });
            if (r.ok === false) break;
            await page.waitForTimeout(500);
          }
          const r = await applyStep(page, { type: 'clickText', pattern: '^' + date.day + '$', pick: 'first' });
          note('day_click', { day: date.day, ok: r.ok, reason: r.reason });
          if (r.ok === false) return fail('date_not_selectable', { date: input.preferred_date });
        }
        await page.waitForTimeout(800);
        const after = await snapshot(page);
        const proceed = (after.controls || []).find(c => c.visible && !c.disabled && /^PROCEED$/i.test(c.text));
        if (proceed) await applyStep(page, { type: 'clickText', pattern: '^PROCEED$', pick: 'last' });
        await page.waitForTimeout(1000);
        continue;
      }
      // unknown intermediate screen: try PROCEED once, otherwise stop and report
      const proceed = ctl.find(c => /^PROCEED$/i.test(c.text));
      note('unknown_screen', { proceed: Boolean(proceed), text: body.slice(0, 500), controls: ctl.map(c => c.text).slice(0, 25) });
      if (!proceed) return fail('unrecognized_screen');
      await applyStep(page, { type: 'clickText', pattern: '^PROCEED$', pick: 'last' });
      await page.waitForTimeout(1000);
    }
    return fail('too_many_screens');
  } catch (err) {
    return { ok: false, status: 'availability_exception', error: serializeError(err), session_id: session.id, session_started_here: startedHere, trace };
  }

  function done(times, row) {
    return { ok: true, status: 'availability_live', slots: times, transport_matched: row.transportMatched || null, rows_on_screen: row.rowsOnScreen || [], session_id: session.id, session_started_here: startedHere, elapsed_ms: Date.now() - t0, trace };
  }
  async function fail(status, extra = {}) {
    let lastText = '';
    try { lastText = (await text()).slice(0, 800); } catch (_e) {}
    return { ok: false, status, ...extra, last_screen_text: lastText, session_id: session.id, session_started_here: startedHere, elapsed_ms: Date.now() - t0, trace };
  }
}

async function applyStep(page, step) {
  const frame = await getReynoldsFrame(page);
  if (step.finalSubmit === true && process.env.LIVE_BOOKING_ENABLED !== 'true') {
    return { ok: false, type: 'blockedFinalSubmit', reason: 'LIVE_BOOKING_ENABLED is not true' };
  }
  if (step.type === 'clickText') return clickText(frame, step.pattern, { pick: step.pick || 'shortest', timeoutMs: step.timeoutMs || (step.firstClick ? FIRST_CLICK_TIMEOUT_MS : DEFAULT_CLICK_TIMEOUT_MS), acceptIfTextAppears: step.acceptIfTextAppears, postClickSettleMs: step.postClickSettleMs });
  if (step.type === 'clickSelector') return clickSelector(frame, step.selector, step.index || 0, { timeoutMs: step.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS });
  if (step.type === 'clickNearbyInput') return clickNearbyInput(frame, step.pattern, step.inputType || 'checkbox');
  if (step.type === 'clickTimeInTransportRow') return clickTimeInTransportRow(frame, step.transport, step.time, { timeoutMs: step.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS });
  if (step.type === 'fill') return fill(frame, step.selector, step.value);
  return { ok: false, reason: 'unknown_step_type', step };
}

export async function startSession({ url = DEFAULT_URL } = {}) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(wsEndpoint());
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
    await getReynoldsFrame(page);
    const id = crypto.randomUUID();
    sessions.set(id, { id, browser, context, page, createdAt: Date.now(), lastUsedAt: Date.now() });
    return { ok: true, id, state: await snapshot(page) };
  } catch (err) {
    await browser?.close().catch(() => {});
    return { ok: false, status: 'start_failed', error: serializeError(err) };
  }
}

export async function stepSession(id, steps = []) {
  const session = sessions.get(id);
  if (!session) return { ok: false, status: 'session_not_found' };
  session.lastUsedAt = Date.now();
  const results = [];
  try {
    for (const step of steps) {
      let result;
      try {
        result = await applyStep(session.page, step);
      } catch (err) {
        result = { ok: false, reason: 'step_exception', error: serializeError(err) };
      }
      results.push({ step, result });
      if (step.waitForText) {
        await session.page.waitForFunction(
          expected => document.body?.innerText?.toLowerCase().includes(String(expected).toLowerCase()),
          step.waitForText,
          { timeout: step.waitTimeoutMs || 5000 }
        ).catch(() => {});
      } else if (step.waitMs) {
        await session.page.waitForLoadState('networkidle', { timeout: Math.min(Number(step.waitMs) || 500, 1200) }).catch(() => {});
      }
      if (result.ok === false) break;
    }
    return { ok: true, status: 'stepped', id, results, state: await snapshot(session.page) };
  } catch (err) {
    return { ok: false, status: 'step_failed', id, results, error: serializeError(err) };
  }
}

export async function getSessionState(id) {
  const session = sessions.get(id);
  if (!session) return { ok: false, status: 'session_not_found' };
  session.lastUsedAt = Date.now();
  try {
    return { ok: true, id, state: await snapshot(session.page) };
  } catch (err) {
    return { ok: false, status: 'state_failed', id, error: serializeError(err) };
  }
}

export async function screenshotSession(id) {
  const session = sessions.get(id);
  if (!session) return { ok: false, status: 'session_not_found' };
  session.lastUsedAt = Date.now();
  try {
    const screenshot = await session.page.screenshot({ encoding: 'base64', fullPage: false });
    return { ok: true, id, screenshot };
  } catch (err) {
    return { ok: false, status: 'screenshot_failed', id, error: serializeError(err) };
  }
}

export async function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return { ok: false, status: 'session_not_found' };
  sessions.delete(id);
  await session.browser.close().catch(() => {});
  return { ok: true, id };
}

setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [id, session] of sessions.entries()) {
    if (session.lastUsedAt < cutoff) {
      sessions.delete(id);
      session.browser.close().catch(() => {});
    }
  }
}, 60 * 1000).unref();
