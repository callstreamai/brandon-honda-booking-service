import { chromium } from 'playwright-core';
import crypto from 'crypto';

const sessions = new Map();
const DEFAULT_URL = 'https://brandonhonda.com/brandon-honda-service-department/schedule-service/';

function wsEndpoint() {
  const token = process.env.BROWSERLESS_API_KEY;
  const region = process.env.BROWSERLESS_REGION || 'production-sfo.browserless.io';
  if (!token) throw new Error('BROWSERLESS_API_KEY is not configured');
  return `wss://${region}/chromium?token=${encodeURIComponent(token)}&timeout=300000&blockAds=true`;
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
  const controls = frame.locator('button, a, [role="button"], input[type="button"], input[type="submit"], li, label, [tabindex]').filter({ hasText: new RegExp(pattern, 'i') });
  const count = await controls.count();
  if (!count) return null;
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const loc = controls.nth(i);
    const text = ((await loc.innerText().catch(async () => await loc.getAttribute('aria-label').catch(() => '') || '')) || '').replace(/\s+/g, ' ').trim();
    const visible = await loc.isVisible().catch(() => false);
    const enabled = await loc.isEnabled().catch(() => true);
    candidates.push({ loc, text, visible, enabled, score: text.length, index: i });
  }
  let pool = candidates.filter(c => c.visible && c.enabled);
  if (!pool.length) pool = candidates.filter(c => c.enabled);
  if (!pool.length) pool = candidates;
  if (pick === 'last') return pool[pool.length - 1];
  if (pick === 'first') return pool[0];
  return pool.sort((a, b) => a.score - b.score)[0];
}

async function clickText(frame, pattern, opts = {}) {
  const candidate = await findControl(frame, pattern, opts);
  if (!candidate) return { ok: false, type: 'clickText', pattern, reason: 'not_found' };
  await candidate.loc.click({ timeout: 10000 });
  return { ok: true, type: 'clickText', pattern, text: candidate.text, index: candidate.index, visible: candidate.visible, enabled: candidate.enabled };
}

async function clickSelector(frame, selector, index = 0) {
  const loc = frame.locator(selector).nth(index);
  const count = await frame.locator(selector).count();
  if (!count || index >= count) return { ok: false, type: 'clickSelector', selector, index, count, reason: 'not_found' };
  await loc.click({ timeout: 10000 });
  const checked = await loc.isChecked().catch(() => false);
  return { ok: true, type: 'clickSelector', selector, index, count, checked };
}

async function clickNearbyInput(frame, pattern, inputType = 'checkbox') {
  const textLoc = frame.locator('div, span, p, label, button, li').filter({ hasText: new RegExp(pattern, 'i') });
  const count = await textLoc.count();
  for (let i = 0; i < count; i++) {
    const loc = textLoc.nth(i);
    const input = loc.locator(`input[type="${inputType}"]`).first();
    if (await input.count()) {
      await input.click({ timeout: 10000 });
      return { ok: true, type: 'clickNearbyInput', pattern, inputType, textIndex: i, checked: await input.isChecked().catch(() => false) };
    }
  }
  return { ok: false, type: 'clickNearbyInput', pattern, inputType, reason: 'not_found' };
}

async function fill(frame, selector, value) {
  const loc = frame.locator(selector).first();
  if (!(await loc.count())) return { ok: false, type: 'fill', selector, reason: 'not_found' };
  await loc.fill(String(value), { timeout: 10000 });
  return { ok: true, type: 'fill', selector, value: String(value) };
}

async function applyStep(page, step) {
  const frame = await getReynoldsFrame(page);
  if (step.finalSubmit === true && process.env.ALLOW_LIVE_SUBMIT !== 'true') {
    return { ok: false, type: 'blockedFinalSubmit', reason: 'ALLOW_LIVE_SUBMIT is not true' };
  }
  if (step.type === 'clickText') return clickText(frame, step.pattern, { pick: step.pick || 'shortest' });
  if (step.type === 'clickSelector') return clickSelector(frame, step.selector, step.index || 0);
  if (step.type === 'clickNearbyInput') return clickNearbyInput(frame, step.pattern, step.inputType || 'checkbox');
  if (step.type === 'fill') return fill(frame, step.selector, step.value);
  return { ok: false, reason: 'unknown_step_type', step };
}

export async function startSession({ url = DEFAULT_URL } = {}) {
  const browser = await chromium.connectOverCDP(wsEndpoint());
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await getReynoldsFrame(page);
  const id = crypto.randomUUID();
  sessions.set(id, { id, browser, context, page, createdAt: Date.now(), lastUsedAt: Date.now() });
  return { id, state: await snapshot(page) };
}

export async function stepSession(id, steps = []) {
  const session = sessions.get(id);
  if (!session) return { ok: false, status: 'session_not_found' };
  session.lastUsedAt = Date.now();
  const results = [];
  for (const step of steps) {
    const result = await applyStep(session.page, step);
    results.push({ step, result });
    await session.page.waitForTimeout(step.waitMs || 1200);
    if (result.ok === false) break;
  }
  return { ok: true, status: 'stepped', id, results, state: await snapshot(session.page) };
}

export async function getSessionState(id) {
  const session = sessions.get(id);
  if (!session) return { ok: false, status: 'session_not_found' };
  session.lastUsedAt = Date.now();
  return { ok: true, id, state: await snapshot(session.page) };
}

export async function screenshotSession(id) {
  const session = sessions.get(id);
  if (!session) return { ok: false, status: 'session_not_found' };
  const screenshot = await session.page.screenshot({ encoding: 'base64', fullPage: false });
  return { ok: true, id, screenshot };
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
