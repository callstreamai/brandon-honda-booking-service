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
    await page.waitForTimeout(500);
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
      await frame.page().waitForTimeout(opts.postClickSettleMs || 1500).catch(() => {});
      const expected = String(opts.acceptIfTextAppears).toLowerCase();
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
      .filter(item => item.text && item.visible && !item.disabled && item.text.length <= 160);
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

async function applyStep(page, step) {
  const frame = await getReynoldsFrame(page);
  if (step.finalSubmit === true && process.env.ALLOW_LIVE_SUBMIT !== 'true') {
    return { ok: false, type: 'blockedFinalSubmit', reason: 'ALLOW_LIVE_SUBMIT is not true' };
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
    await page.waitForTimeout(2500);
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
      await session.page.waitForTimeout(step.waitMs || 1200);
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
