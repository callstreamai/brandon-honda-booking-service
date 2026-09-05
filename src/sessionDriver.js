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
  return `wss://${region}/chromium?token=${encodeURIComponent(token)}&timeout=${BROWSERLESS_TIMEOUT_MS}&blockAds=true`;
}
// Browserless closes the remote browser this long after connect, no matter what the page is doing.
// Every session therefore has a hard expiry; the pool must never hand out one that cannot outlive a call.
const BROWSERLESS_TIMEOUT_MS = Number(process.env.BROWSERLESS_TIMEOUT_MS || String(15 * 60 * 1000));
const CALL_RESERVE_MS = Number(process.env.SESSION_CALL_RESERVE_MS || String(6 * 60 * 1000));
const isClosedError = err => /has been closed|Target closed|browser has been closed|Session closed|Connection closed|disconnected|WebSocket is not open|Target page, context or browser/i.test(String(err && (err.message || err)));

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
  // One round-trip per locator: reading each candidate with its own call can wait out a timeout
  // per element while the portal re-renders, which is where the 30-second stalls came from.
  const collect = async (locator, strategy) => {
    const infos = await locator.evaluateAll(els => els.map(el => {
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      const text = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      return {
        text,
        visible: r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none',
        enabled: !(el.disabled || el.getAttribute('aria-disabled') === 'true' || /disabled/i.test(String(el.className || '')))
      };
    })).catch(() => []);
    return infos.map((x, i) => ({ ...x, index: i, score: x.text.length, strategy, loc: locator.nth(i) })).filter(c => c.text && re.test(c.text));
  };
  const choose = p => pick === 'last' ? p[p.length - 1] : pick === 'first' ? p[0] : p.slice().sort((a, b) => a.score - b.score)[0];
  const roleCands = await collect(frame.getByRole('button'), 'role:button');
  let pool = roleCands.filter(c => c.visible && c.enabled);
  if (pool.length) return choose(pool);
  const genCands = await collect(frame.locator('button, a, [role="button"], input[type="button"], input[type="submit"], li, label, [tabindex]'), 'generic');
  const all = [...roleCands, ...genCands];
  if (!all.length) return null;
  pool = genCands.filter(c => c.visible && c.enabled);
  if (!pool.length) return { error: 'no_visible_enabled_match', candidates: all.map(({ loc, ...rest }) => rest).slice(0, 20) };
  return choose(pool);
}

async function clickText(frame, pattern, opts = {}) {
  const candidate = await findControl(frame, pattern, opts);
  if (!candidate) return { ok: false, type: 'clickText', pattern, reason: 'not_found' };
  if (candidate.error) return { ok: false, type: 'clickText', pattern, reason: candidate.error, candidates: candidate.candidates };
  try {
    await candidate.loc.click({ timeout: opts.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS, force: opts.force !== false });
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

// Clicks the smallest visible element whose text matches, or its nearest clickable ancestor.
// Covers the portal's div-based tiles (service menu, advisor cards, calendar days) that are
// not buttons, links, or labels.
async function clickAnyText(frame, pattern, opts = {}) {
  const marker = `kafka-text-${crypto.randomUUID()}`;
  const found = await frame.evaluate(({ pattern, marker }) => {
    const compact = s => (s || '').replace(/\s+/g, ' ').trim();
    const re = new RegExp(pattern, 'i');
    const isVisible = el => { const r = el.getBoundingClientRect(); const st = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'; };
    const all = Array.from(document.querySelectorAll('body *')).filter(el => !['SCRIPT', 'STYLE', 'HTML', 'BODY'].includes(el.tagName) && isVisible(el));
    const matches = all.map(el => ({ el, text: compact(el.innerText || el.textContent || '') }))
      .filter(x => x.text && x.text.length <= 200 && re.test(x.text))
      .sort((a, b) => a.text.length - b.text.length);
    if (!matches.length) return { ok: false, reason: 'not_found' };
    let target = matches[0].el;
    for (let node = target, d = 0; node && d < 4; d++, node = node.parentElement) {
      if (node.matches('button, a, [role="button"], label, li, [onclick], [tabindex]')) { target = node; break; }
    }
    target.setAttribute('data-kafka-text-target', marker);
    return { ok: true, matched: matches[0].text, tag: target.tagName.toLowerCase(), matchCount: matches.length };
  }, { pattern, marker });
  if (!found.ok) return { ok: false, type: 'clickAnyText', pattern, reason: found.reason };
  try {
    await frame.locator(`[data-kafka-text-target="${marker}"]`).click({ timeout: opts.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS });
    return { ok: true, type: 'clickAnyText', pattern, matched: found.matched, tag: found.tag, matchCount: found.matchCount };
  } catch (err) {
    return { ok: false, type: 'clickAnyText', pattern, reason: 'click_failed', error: serializeError(err) };
  } finally {
    await frame.evaluate(m => document.querySelectorAll(`[data-kafka-text-target="${m}"]`).forEach(el => el.removeAttribute('data-kafka-text-target')), marker).catch(() => {});
  }
}

// Finds the element whose own text matches, walks up to the tile that contains exactly one
// checkbox/radio, and checks it. The service menu uses hidden inputs that all share id
// "ItemCheckbox", so neither id nor label selectors work; proximity to the tile text does.
async function clickCheckboxNearText(frame, pattern, opts = {}) {
  const marker = `kafka-cb-${crypto.randomUUID()}`;
  const found = await frame.evaluate(({ pattern, marker }) => {
    const compact = s => (s || '').replace(/\s+/g, ' ').trim();
    const re = new RegExp(pattern, 'i');
    const isVisible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const nodes = Array.from(document.querySelectorAll('body *')).filter(el => !['SCRIPT', 'STYLE'].includes(el.tagName) && isVisible(el))
      .map(el => ({ el, text: compact(el.innerText || el.textContent || '') }))
      .filter(x => x.text && x.text.length <= 120 && re.test(x.text))
      .sort((a, b) => a.text.length - b.text.length);
    for (const n of nodes) {
      for (let node = n.el, d = 0; node && d < 8; d++, node = node.parentElement) {
        const boxes = Array.from(node.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
        if (boxes.length === 1) { boxes[0].setAttribute('data-kafka-cb-target', marker); return { ok: true, matched: n.text, depth: d, wasChecked: boxes[0].checked }; }
        if (boxes.length > 1) break; // walked past the tile into the whole list
      }
    }
    return { ok: false, reason: nodes.length ? 'no_single_checkbox_near_text' : 'not_found' };
  }, { pattern, marker });
  if (!found.ok) return { ok: false, type: 'clickCheckboxNearText', pattern, reason: found.reason };
  const loc = frame.locator(`[data-kafka-cb-target="${marker}"]`);
  try {
    await loc.click({ timeout: opts.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS, force: true }).catch(() => {});
    let checked = await loc.isChecked().catch(() => null);
    if (checked === false) { await loc.check({ timeout: 5000, force: true }).catch(() => {}); checked = await loc.isChecked().catch(() => null); }
    if (checked === false) {
      // hidden input that ignores synthetic clicks: click the visible tile text instead
      const alt = await clickAnyText(frame, pattern, opts);
      checked = await loc.isChecked().catch(() => null);
      return { ok: checked !== false, type: 'clickCheckboxNearText', pattern, matched: found.matched, checked, viaTile: alt.ok };
    }
    return { ok: true, type: 'clickCheckboxNearText', pattern, matched: found.matched, checked };
  } catch (err) {
    return { ok: false, type: 'clickCheckboxNearText', pattern, reason: 'click_failed', error: serializeError(err) };
  } finally {
    await frame.evaluate(m => document.querySelectorAll(`[data-kafka-cb-target="${m}"]`).forEach(el => el.removeAttribute('data-kafka-cb-target')), marker).catch(() => {});
  }
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
    const norm = s => compact(s).toLowerCase().replace(/\.$/, '');
    const timeRe = /^(0?\d|1[0-2]):[0-5]\d\s?(am|pm)$/i;
    const afterRe = /^before 0?6:00\s?am$/i;
    const isVisible = el => { const r = el.getBoundingClientRect(); const st = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'; };
    const isDisabled = el => Boolean(el.disabled) || /disabled/i.test(String(el.className || '')) || el.getAttribute('aria-disabled') === 'true';
    const known = ['i am dropping off my vehicle', 'i am leaving my vehicle after hours', 'i am waiting with my vehicle', 'i will take the shuttle'];
    const desired = norm(transport);
    // 1. one label element per transport row: the smallest visible element whose whole text is that label
    const all = Array.from(document.querySelectorAll('body *')).filter(el => !['SCRIPT', 'STYLE'].includes(el.tagName) && isVisible(el));
    const labels = [];
    for (const k of known) {
      const cands = all.map(el => ({ el, text: norm(el.innerText || el.textContent || '') })).filter(x => x.text === k);
      if (cands.length) labels.push({ key: k, el: cands.sort((a, b) => (a.el.innerText || '').length - (b.el.innerText || '').length)[0].el });
    }
    // 2. every visible enabled time control, in document order
    const timeEls = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a, li, div, span'))
      .filter(el => isVisible(el) && !isDisabled(el))
      .map(el => ({ el, text: compact(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '') }))
      .filter(x => (timeRe.test(x.text) || afterRe.test(x.text)) && !Array.from(x.el.children).some(c => timeRe.test(compact(c.innerText || '')) || afterRe.test(compact(c.innerText || ''))));
    const rowsOnScreen = labels.map(l => l.key);
    if (!labels.some(l => l.key === desired)) return { ok: false, reason: 'transport_row_not_found', transport, rowsOnScreen, allTimeCount: timeEls.length };
    // 3. labels are a header block; the grids follow in row order. Cluster the time controls by
    //    their container, order clusters by document position, and pair cluster i with label i.
    //    The after-hours row has a single "Before 06:00am" control, which anchors the alignment.
    const byRow = Object.fromEntries(known.map(k => [k, []]));
    // each grid is an ascending list of times; a time that is not later than the previous one
    // (or the after-hours pseudo-slot) starts a new grid. Independent of the DOM wrappers.
    const minutes = txt => { const m = txt.match(/^(0?\d|1[0-2]):([0-5]\d)\s?(am|pm)$/i); if (!m) return -1; let h = Number(m[1]) % 12; if (m[3].toLowerCase() === 'pm') h += 12; return h * 60 + Number(m[2]); };
    const clusters = [];
    let prev = null;
    for (const t of timeEls) {
      const cur = afterRe.test(t.text) ? -1 : minutes(t.text);
      const last = clusters[clusters.length - 1];
      if (last && prev !== null && prev >= 0 && cur > prev) last.items.push(t);
      else clusters.push({ items: [t] });
      prev = cur;
    }
    const orderedLabels = labels.slice().sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    let offset = 0;
    const afterIdx = clusters.findIndex(c => c.items.some(t => afterRe.test(t.text)));
    const afterLabelIdx = orderedLabels.findIndex(l => l.key === 'i am leaving my vehicle after hours');
    if (afterIdx >= 0 && afterLabelIdx >= 0) offset = afterLabelIdx - afterIdx;
    clusters.forEach((c, i) => {
      const label = orderedLabels[i + offset];
      if (label) byRow[label.key].push(...c.items.map(t => t.text));
    });
    const clusterSizes = clusters.map(c => c.items.length);
    const times = Array.from(new Set(byRow[desired]));
    const counts = Object.fromEntries(Object.entries(byRow).map(([k, v]) => [k, v.length]));
    // run-length encoded document order of labels (L) and time controls (T), for debugging row layout
    const items = [...labels.map(l => ({ el: l.el, tag: 'L:' + l.key.split(' ').slice(2, 4).join('_') })), ...timeEls.map(t => ({ el: t.el, tag: afterRe.test(t.text) ? 'A' : 'T' }))]
      .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    const sequence = []; for (const it of items) { const last = sequence[sequence.length - 1]; if (last && last.tag === it.tag) last.n++; else sequence.push({ tag: it.tag, n: 1 }); }
    const seq = sequence.map(x => x.n > 1 ? `${x.tag}x${x.n}` : x.tag).join(' ');
    if (!times.length) return { ok: false, reason: 'row_found_no_times', transport, rowsOnScreen, allTimeCount: timeEls.length, counts, clusterSizes };
    return { ok: true, transportMatched: desired, times, rowsOnScreen, allTimeCount: timeEls.length, counts, seq, clusterSizes };
  }, { transport });
}

function parseUsDate(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return { month: Number(m[1]), day: Number(m[2]), year: Number(m[3]) };
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const STAGES = ['start', 'entry', 'vehicle', 'mileage', 'service', 'date', 'grid'];
const stageIndex = st => STAGES.indexOf(st);
const sessionsByCall = new Map(); // call_id -> session id

export function resolveSessionId({ session_id, call_id } = {}) {
  if (session_id && sessions.has(session_id)) return session_id;
  if (call_id && sessionsByCall.has(call_id) && sessions.has(sessionsByCall.get(call_id))) return sessionsByCall.get(call_id);
  return null;
}

export function bindSessionToCall(id, callId) {
  if (id && callId) sessionsByCall.set(String(callId), id);
}

function normalizeInput(input = {}) {
  const transport = String(input.transport_option || input.transportation_plan || '').trim();
  const serviceLabel = String(input.service_label || '').trim();
  const freeText = String(input.service_free_text || input.service_concern || '').trim();
  return {
    year: String(input.vehicle_year || '').trim(),
    model: String(input.vehicle_model || '').trim(),
    mileage: String(input.vehicle_mileage || '').replace(/[^\d]/g, ''),
    serviceLabel,
    freeText,
    serviceKey: serviceLabel && serviceLabel.toUpperCase() !== 'TELL US' ? 'label:' + serviceLabel : (serviceLabel || freeText ? 'tellus:' + freeText : ''),
    transport,
    date: parseUsDate(input.preferred_date),
    dateKey: String(input.preferred_date || '').trim()
  };
}

// Serializes work per session: a background advance and a later /availability call never
// drive the same browser at the same time; the later call simply waits its turn.
function withSessionLock(session, fn) {
  const run = (session.pending || Promise.resolve()).catch(() => {}).then(fn);
  session.pending = run;
  return run;
}

// Idempotent walker. Looks at the current screen and applies only the steps whose data is
// present, up to `until` (a STAGES entry). Safe to call repeatedly with growing input: every
// step is gated on the screen it expects, so re-running is a no-op for stages already done.
// If the vehicle or service differs from what was already applied, the session restarts,
// since the portal offers no way back that we trust.
async function walk(session, input, until = 'grid') {
  const t0 = Date.now();
  const trace = session.trace = session.trace || [];
  const note = (screen, detail) => trace.push({ t: Date.now() - t0, screen, ...detail });
  const inp = normalizeInput(input);
  const page = session.page;
  session.applied = session.applied || {};
  const ap = session.applied;

  const text = async () => (await getReynoldsFrame(page)).evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
  const has = (t, needle) => t.toLowerCase().includes(String(needle).toLowerCase());
  async function clickUntil(step, expectText, { absent = false, attempts = 6, waitMs = 1500 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const r = await applyStep(page, step);
      await page.waitForFunction(({ expected, absent }) => {
        const t = (document.body?.innerText || '').toLowerCase();
        return absent ? !t.includes(expected) : t.includes(expected);
      }, { expected: String(expectText).toLowerCase(), absent }, { timeout: waitMs }).catch(() => {});
      const t = await text();
      const ok = absent ? !has(t, expectText) : has(t, expectText);
      if (ok) { note(step.pattern || step.selector || step.type, { attempt: i + 1, result: r.ok, reason: r.reason }); return true; }
      if (r.ok === false && r.reason === 'not_found' && i >= 1) break;
    }
    const snap = await snapshot(page).catch(() => ({}));
    note(step.pattern || step.selector || step.type, { failed: true, lastText: (await text()).slice(0, 400), controls: (snap.controls || []).filter(c => c.visible).map(c => (c.disabled ? '(dis)' : '') + c.text.slice(0, 40)).slice(0, 40) });
    return false;
  }
  const fail = async (status, extra = {}) => {
    let lastText = ''; try { lastText = (await text()).slice(0, 800); } catch (_e) {}
    session.stage = session.stage || 'start';
    return { ok: false, status, ...extra, stage: session.stage, last_screen_text: lastText, session_id: session.id, elapsed_ms: Date.now() - t0, trace };
  };
  const reached = st => { session.stage = st; return stageIndex(st) >= stageIndex(until); };
  const done = extra => ({ ok: true, stage: session.stage, session_id: session.id, elapsed_ms: Date.now() - t0, trace, ...extra });

  try {
    let t = await text();
    // ---- entry (always)
    if (has(t, 'Schedule your service appointment') && !has(t, "I'M NEW") && !has(t, 'Select Your Make')) {
      if (!await clickUntil({ type: 'clickText', pattern: 'Schedule Appointment', pick: 'shortest', firstClick: true }, "I'M NEW")) return fail('entry_failed');
    }
    t = await text();
    if (has(t, "I'M NEW") && !has(t, 'Select Your Make') && !ap.vehicle) {
      if (!await clickUntil({ type: 'clickText', pattern: "^I'M NEW$", pick: 'shortest', firstClick: true }, 'Select Your Make')) return fail('guest_entry_failed');
    }
    if (reached('entry')) return done();

    // ---- vehicle
    if (!inp.year || !inp.model) return done({ waiting_for: 'vehicle' });
    const vehicleKey = `${inp.year}|${inp.model}`;
    if (ap.vehicle && ap.vehicle !== vehicleKey) return { restart: true, reason: 'vehicle_changed' };
    t = await text();
    if (!ap.vehicle && has(t, 'Select Your Make')) {
      if (!await clickUntil({ type: 'clickText', pattern: '^Honda$' }, 'Select Your Make', { absent: true, waitMs: 1200 }) && !has(await text(), inp.year)) return fail('make_failed');
      if (!has(await text(), 'Select Model')) {
        if (!await clickUntil({ type: 'clickText', pattern: '^' + escapeRegex(inp.year) + '$' }, 'Select Model', { attempts: 3, waitMs: 1200 })) return fail('year_not_available', { year: inp.year });
      }
      await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
      if (!await clickUntil({ type: 'clickText', pattern: '^' + escapeRegex(inp.model) + '$', timeoutMs: 5000 }, 'Estimated Mileage', { attempts: 3 })) return fail('model_not_available_for_year', { year: inp.year, model: inp.model });
      ap.vehicle = vehicleKey;
    }
    if (reached('vehicle')) return done();

    // ---- mileage (accepts unknown)
    t = await text();
    if (has(t, 'Estimated Mileage') && !ap.mileage) {
      if (inp.mileage) await applyStep(page, { type: 'fill', selector: '#estMileageText_input', value: inp.mileage });
      else await applyStep(page, { type: 'clickSelector', selector: '#estMilCheckbox' });
      if (!await clickUntil({ type: 'clickText', pattern: '^PROCEED$', pick: 'last' }, 'Estimated Mileage', { absent: true })) return fail('mileage_proceed_failed');
      ap.mileage = inp.mileage || 'unknown';
    }
    if (reached('mileage')) return done();

    // ---- service
    if (!inp.serviceKey) return done({ waiting_for: 'service' });
    if (ap.service && ap.service !== inp.serviceKey) return { restart: true, reason: 'service_changed' };
    t = await text();
    if (!ap.service && (has(t, 'INDIVIDUAL SERVICES') || has(t, 'TELL US'))) {
      if (inp.serviceKey.startsWith('label:')) {
        const r = await applyStep(page, { type: 'clickCheckboxNearText', pattern: '^' + escapeRegex(inp.serviceLabel) + '$' });
        note('service_label', { label: inp.serviceLabel, ok: r.ok, reason: r.reason, checked: r.checked, viaTile: r.viaTile });
        if (r.ok === false) return fail('service_label_not_found', { label: inp.serviceLabel, detail: r });
      } else {
        const r1 = await applyStep(page, { type: 'clickText', pattern: 'TELL US', pick: 'shortest' });
        const r2 = await applyStep(page, { type: 'fill', selector: 'textarea', value: inp.freeText || 'Customer request, see notes' });
        note('service_tell_us', { tab: r1.ok, filled: r2.ok, reason: r2.reason });
        if (r2.ok === false) return fail('tell_us_textarea_not_found');
        // The TELL US tab is a two-step form: type the issue, then ADD ISSUE. PROCEED stays disabled
        // ("Please select a service to continue.") until the issue shows under "Added Issue".
        if (!has(await text(), 'Added Issue')) {
          const r3 = await applyStep(page, { type: 'clickText', pattern: '^ADD ISSUE$' });
          await page.waitForFunction(() => /Added Issue/i.test(document.body?.innerText || ''), null, { timeout: 5000 }).catch(() => {});
          const added = has(await text(), 'Added Issue');
          note('service_tell_us_add', { clicked: r3.ok, added });
          if (!added) return fail('tell_us_add_issue_failed');
        }
      }
      // the mileage screen's mixed-case 'Proceed' stays mounted; the service footer is uppercase 'PROCEED'
      await page.waitForFunction(() => Array.from(document.querySelectorAll('button, [role="button"]')).some(b => (b.innerText || '').trim() === 'PROCEED' && !b.disabled && b.getBoundingClientRect().height > 0), null, { timeout: 8000 }).catch(() => {});
      if (!await clickUntil({ type: 'clickText', pattern: '^(PROCEED|NEXT|CONTINUE|DONE)$', pick: 'last', noFallback: true, force: true, timeoutMs: 4000 }, 'ANY ADVISOR', { waitMs: 6000, attempts: 3 })) return fail('service_proceed_failed');
      ap.service = inp.serviceKey;
    }
    if (reached('service')) return done();

    // ---- date (+ advisor, same screen) and grid
    if (!inp.date) return done({ waiting_for: 'date' });
    let advisorDone = false;
    for (let hop = 0; hop < 8; hop++) {
      const frame = await getReynoldsFrame(page);
      const st = await snapshot(page);
      const body = st.text || '';
      const ctl = (st.controls || []).filter(c => c.visible && !c.disabled);
      const timesVisible = ctl.filter(c => TIME_RE.test(c.text) || /^before 0?6:00\s?am$/i.test(c.text));
      const gridReady = timesVisible.length > 0 || /\b(0?\d|1[0-2]):[0-5]\d\s?(am|pm)\b/i.test(body);
      const headerHasDate = new RegExp(`\\b${MONTHS[inp.date.month - 1]}\\s+${inp.date.day}\\b`, 'i').test(body);
      if (gridReady && (ap.date === inp.dateKey || headerHasDate)) {
        ap.date = inp.dateKey;
        session.stage = 'grid';
        if (stageIndex(until) < stageIndex('grid')) return done();
        const transport = inp.transport || 'I am dropping off my vehicle.';
        const isAfterHours = transport.toLowerCase().includes(AFTER_HOURS_LABEL);
        const row = await listTimesInTransportRow(frame, transport);
        note('time_grid', { rowOk: row.ok, reason: row.reason, count: row.times ? row.times.length : 0, counts: row.counts, clusterSizes: row.clusterSizes, allTimeCount: row.allTimeCount });
        if (!row.ok) return fail('transport_row_not_found', { detail: row });
        return done({ slots: isAfterHours ? row.times.filter(x => /^before/i.test(x)) : row.times.filter(x => !/^before/i.test(x)), transport_matched: row.transportMatched, rows_on_screen: row.rowsOnScreen });
      }
      if (/would you like to see a certain advisor/i.test(body) && !advisorDone && !gridReady) {
        advisorDone = true;
        let r = await applyStep(page, { type: 'clickCheckboxNearText', pattern: '^ANY ADVISOR$' });
        if (r.ok === false) r = await applyStep(page, { type: 'clickAnyText', pattern: '^ANY ADVISOR$' });
        note('advisor', { selected: r.ok, checked: r.checked, reason: r.reason });
        if (!await clickUntil({ type: 'clickText', pattern: '^(PROCEED|NEXT|CONTINUE|DONE)$', pick: 'last', noFallback: true, force: true, timeoutMs: 4000 }, 'would you like to see a certain advisor', { absent: true, waitMs: 2500 })) return fail('advisor_proceed_failed');
        continue;
      }
      const dateInput = (st.fields || []).find(f => f.visible && (f.type === 'date' || /date/i.test(f.id + f.name + f.placeholder)));
      const dayButtons = ctl.filter(c => /^\d{1,2}$/.test(c.text));
      const monthShown = MONTHS.findIndex(m => body.toLowerCase().includes(m));
      if (dateInput || dayButtons.length >= 20) {
        note('date_screen', { dateInput: dateInput ? dateInput.id : null, dayButtons: dayButtons.length, monthShown: monthShown >= 0 ? MONTHS[monthShown] : null, gridReady, headerHasDate });
        if (dateInput) {
          const iso = `${inp.date.year}-${String(inp.date.month).padStart(2, '0')}-${String(inp.date.day).padStart(2, '0')}`;
          await applyStep(page, { type: 'fill', selector: dateInput.id ? '#' + dateInput.id : 'input[type="date"]', value: iso });
        } else {
          for (let m = 0; m < 6 && monthShown >= 0; m++) {
            const nowText = (await text()).toLowerCase();
            const cur = MONTHS.findIndex(mm => nowText.includes(mm));
            if (cur === inp.date.month - 1) break;
            const r = await applyStep(page, { type: 'clickText', pattern: '(next|›|>|chevron_right|arrow_forward)', pick: 'shortest' });
            note('calendar_next', { ok: r.ok, reason: r.reason });
            if (r.ok === false) break;
            await page.waitForTimeout(500);
          }
          const r = await applyStep(page, { type: 'clickText', pattern: '^' + inp.date.day + '$', pick: 'first' });
          note('day_click', { day: inp.date.day, ok: r.ok, reason: r.reason });
          if (r.ok === false) return fail('date_not_selectable', { date: inp.dateKey });
          // the grid takes up to ~10 s to render after the day is chosen
          await page.waitForFunction(() => /\b(0?\d|1[0-2]):[0-5]\d\s?(am|pm)\b/i.test(document.body?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
        }
        await page.waitForTimeout(500);
        continue;
      }
      const proceed = ctl.find(c => /^PROCEED$/i.test(c.text));
      note('unknown_screen', { proceed: Boolean(proceed), text: body.slice(0, 500), controls: ctl.map(c => c.text).slice(0, 25) });
      if (!proceed) return fail('unrecognized_screen');
      await applyStep(page, { type: 'clickText', pattern: '^PROCEED$', pick: 'last' });
      await page.waitForTimeout(1000);
    }
    return fail('too_many_screens');
  } catch (err) {
    if (isClosedError(err) || (session.browser && session.browser.isConnected && !session.browser.isConnected())) {
      note('session_dead', { error: String(err && err.message || err).slice(0, 160), age_ms: Date.now() - session.createdAt });
      return { restart: true, reason: 'session_closed', trace };
    }
    return { ok: false, status: 'walk_exception', error: serializeError(err), stage: session.stage, session_id: session.id, elapsed_ms: Date.now() - t0, trace };
  }
}

// ---- Warm session pool ------------------------------------------------------
// Keeps a few portal sessions pre-connected and parked at the entry screen so a call
// claims one instantly instead of paying the ~5-6s Browserless connect + portal load at
// answer time. Pre-warm during the disclosure still runs; the pool makes it instant and
// covers the case where the pre-warm webhook is skipped or slow.
const POOL = []; // ids of ready, unbound sessions
let warming = 0;
const POOL_SIZE = Math.max(0, Number(process.env.SESSION_POOL_SIZE || '1'));
const POOL_MAX_AGE_MS = Math.min(Number(process.env.SESSION_POOL_MAX_AGE_MS || String(5 * 60 * 1000)), BROWSERLESS_TIMEOUT_MS - CALL_RESERVE_MS);

function sessionLifeLeft(session) { return session.createdAt + BROWSERLESS_TIMEOUT_MS - Date.now(); }

function poolFresh(session) {
  if (!session) return false;
  if (Date.now() - session.createdAt > POOL_MAX_AGE_MS) return false;
  if (sessionLifeLeft(session) < CALL_RESERVE_MS) return false;
  try { if (session.browser && session.browser.isConnected && !session.browser.isConnected()) return false; } catch (_e) {}
  return true;
}

async function warmOne() {
  if (POOL.length + warming >= POOL_SIZE) return;
  warming++;
  try {
    const started = await startSession({ pooled: true });
    if (started.ok) POOL.push(started.id);
  } catch (_e) {} finally { warming--; }
}

function poolTopUp() {
  const need = POOL_SIZE - POOL.length - warming;
  for (let i = 0; i < need; i++) warmOne();
}

// Return a ready pooled session (dropping any that went stale), or null. Backfills after.
function acquireFromPool() {
  while (POOL.length) {
    const id = POOL.shift();
    const session = sessions.get(id);
    if (poolFresh(session)) { poolTopUp(); return session; }
    if (session) { sessions.delete(id); session.browser?.close().catch(() => {}); }
  }
  poolTopUp();
  return null;
}

async function acquireSession() {
  const pooled = acquireFromPool();
  if (pooled) { pooled.pooled = false; pooled.lastUsedAt = Date.now(); return { session: pooled, fromPool: true }; }
  const started = await startSession({});
  if (!started.ok) return { error: started };
  return { session: sessions.get(started.id), fromPool: false };
}

// Keep the pool topped up and prune stale members.
setInterval(() => {
  for (let i = POOL.length - 1; i >= 0; i--) {
    const session = sessions.get(POOL[i]);
    if (!poolFresh(session)) { POOL.splice(i, 1); if (session) { sessions.delete(session.id); session.browser?.close().catch(() => {}); } }
  }
  poolTopUp();
}, 30 * 1000).unref();
poolTopUp();

async function getOrStartSession(ref = {}) {
  const id = resolveSessionId(ref);
  if (id) {
    const existing = sessions.get(id);
    const alive = existing && !(existing.browser && existing.browser.isConnected && !existing.browser.isConnected());
    if (existing && alive) return { session: existing, startedHere: false };
    if (existing) { console.log(JSON.stringify({ event: 'session_replaced', reason: 'dead', call_id: ref.call_id || null, age_ms: Date.now() - existing.createdAt })); sessions.delete(id); existing.browser?.close().catch(() => {}); }
  }
  const got = await acquireSession();
  if (got.error) return { error: got.error };
  if (ref.call_id) bindSessionToCall(got.session.id, ref.call_id);
  return { session: got.session, startedHere: true, fromPool: got.fromPool };
}

async function restartSession(session, callId) {
  sessions.delete(session.id);
  for (const [c, id] of sessionsByCall.entries()) if (id === session.id) sessionsByCall.delete(c);
  await session.browser.close().catch(() => {});
  const got = await acquireSession();
  if (got.error) return null;
  if (callId) bindSessionToCall(got.session.id, callId);
  return got.session;
}

// Pool-aware session acquisition for the explicit pre-warm endpoint: reuse the call's
// session if one exists, else claim a warm one (instant) or cold-start.
export async function acquireBoundSession(callId, url) {
  const existing = resolveSessionId({ call_id: callId });
  if (existing) return { id: existing, reused: true };
  const got = await acquireSession();
  if (got.error) return { error: got.error };
  if (callId) bindSessionToCall(got.session.id, callId);
  return { id: got.session.id, fromPool: Boolean(got.fromPool) };
}

// Advance as far as the known fields allow (default: through the service menu, or the date
// screen when a date is known). Returns the promise of the walk; callers may respond without
// awaiting it, since /availability will wait on the session lock anyway.
export async function advanceSession(ref, input = {}, { until, wait = false } = {}) {
  const got = await getOrStartSession(ref);
  if (got.error) return { ok: false, status: 'session_start_failed', error: got.error.error };
  let session = got.session;
  const target = until || (input.preferred_date ? 'date' : 'service');
  const job = withSessionLock(session, async () => {
    let r = await walk(session, input, target);
    if (r.restart) {
      const fresh = await restartSession(session, ref.call_id);
      if (!fresh) return { ok: false, status: 'restart_failed' };
      fresh.trace = [{ t: 0, screen: 'restart', reason: r.reason }];
      session = fresh;
      r = await walk(fresh, input, target);
    }
    return r;
  });
  if (!wait) {
    job.then(r => console.log(JSON.stringify({ event: 'advance_done', call_id: ref.call_id || null, target, ok: r && r.ok, status: r && r.status, stage: r && r.stage, waiting_for: r && r.waiting_for, elapsed_ms: r && r.elapsed_ms, dead: (r && r.trace || []).some(t => t.screen === 'session_dead') || undefined })))
       .catch(err => console.warn(JSON.stringify({ event: 'advance_done', call_id: ref.call_id || null, target, ok: false, error: String(err && err.message || err).slice(0, 200) })));
    return { ok: true, accepted: true, session_id: session.id, target, started_here: got.startedHere };
  }
  return { ...(await job), started_here: got.startedHere };
}

// Full availability read: waits for any in-flight advance, walks the rest, returns the row's slots.
export async function collectAvailability(sessionId, input = {}) {
  const ref = { session_id: sessionId, call_id: input.call_id };
  const got = await getOrStartSession(ref);
  if (got.error) return { ok: false, status: 'session_start_failed', error: got.error.error, trace: [] };
  let session = got.session;
  const result = await withSessionLock(session, async () => {
    let r = await walk(session, input, 'grid');
    if (r.restart) {
      const fresh = await restartSession(session, ref.call_id);
      if (!fresh) return { ok: false, status: 'restart_failed', trace: [] };
      fresh.trace = [{ t: 0, screen: 'restart', reason: r.reason }];
      session = fresh;
      r = await walk(fresh, input, 'grid');
    }
    return r;
  });
  if (result.ok && result.waiting_for) return { ...result, ok: false, status: 'missing_' + result.waiting_for };
  return { ...result, session_started_here: got.startedHere };
}

async function applyStep(page, step) {
  const frame = await getReynoldsFrame(page);
  if (step.finalSubmit === true && process.env.LIVE_BOOKING_ENABLED !== 'true') {
    return { ok: false, type: 'blockedFinalSubmit', reason: 'LIVE_BOOKING_ENABLED is not true' };
  }
  if (step.type === 'clickText') {
    const r = await clickText(frame, step.pattern, { pick: step.pick || 'shortest', timeoutMs: step.timeoutMs || (step.firstClick ? FIRST_CLICK_TIMEOUT_MS : DEFAULT_CLICK_TIMEOUT_MS), acceptIfTextAppears: step.acceptIfTextAppears, postClickSettleMs: step.postClickSettleMs, force: step.force });
    if (r.ok !== false || step.noFallback) return r;
    // not a button/link/label: fall back to any visible element with that text
    const alt = await clickAnyText(frame, step.pattern, { timeoutMs: step.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS });
    return alt.ok ? { ...alt, fallbackFrom: r.reason } : { ...r, fallback: alt };
  }
  if (step.type === 'clickAnyText') return clickAnyText(frame, step.pattern, { timeoutMs: step.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS });
  if (step.type === 'clickCheckboxNearText') return clickCheckboxNearText(frame, step.pattern, { timeoutMs: step.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS });
  if (step.type === 'clickSelector') return clickSelector(frame, step.selector, step.index || 0, { timeoutMs: step.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS });
  if (step.type === 'clickNearbyInput') return clickNearbyInput(frame, step.pattern, step.inputType || 'checkbox');
  if (step.type === 'clickTimeInTransportRow') return clickTimeInTransportRow(frame, step.transport, step.time, { timeoutMs: step.timeoutMs || DEFAULT_CLICK_TIMEOUT_MS });
  if (step.type === 'fill') return fill(frame, step.selector, step.value);
  return { ok: false, reason: 'unknown_step_type', step };
}

export async function startSession({ url = DEFAULT_URL, pooled = false } = {}) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(wsEndpoint());
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    const network = [];
    const t0 = Date.now();
    // Record the portal's own API traffic (XHR/fetch to reyrey.net) so the flow can be mapped
    // to direct calls. Bodies are truncated; the log is capped at 300 entries per session.
    page.on('response', async res => {
      try {
        const req = res.request();
        const rt = req.resourceType();
        if (!/reyrey\.net/i.test(req.url()) || !['xhr', 'fetch', 'document', 'script'].includes(rt)) return;
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        let body = null;
        if (/json|text|javascript/.test(ct) && rt !== 'document') { body = (await res.text().catch(() => '')).slice(0, 30000); }
        const rh = req.headers();
        const keep = {};
        for (const k of Object.keys(rh)) if (!/^(cookie|user-agent|accept-language|sec-|referer|origin)$/i.test(k) && !k.startsWith(':')) keep[k] = String(rh[k]).slice(0, 400);
        network.push({ t: Date.now() - t0, type: rt, method: req.method(), url: req.url(), reqHeaders: keep, postData: (req.postData() || '').slice(0, 8000), status: res.status(), respContentType: ct, body });
        if (network.length > 300) network.shift();
      } catch (_e) {}
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
    await getReynoldsFrame(page);
    const id = crypto.randomUUID();
    sessions.set(id, { id, browser, context, page, network, pooled, createdAt: Date.now(), lastUsedAt: Date.now() });
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

// Fetches a reyrey.net URL from inside the session's page (same origin, same cookies) and
// returns either the text or regex-matched snippets. Mapping aid only; host-restricted.
export async function fetchTextViaSession(id, url, { grep, context = 300, maxSnippets = 20, maxText = 20000 } = {}) {
  const session = sessions.get(id);
  if (!session) return { ok: false, status: 'session_not_found' };
  if (!/^https:\/\/[a-z0-9.-]*reyrey\.net\//i.test(url)) return { ok: false, status: 'host_not_allowed' };
  session.lastUsedAt = Date.now();
  try {
    const text = await session.page.evaluate(async u => { const r = await fetch(u, { credentials: 'include' }); return { status: r.status, text: await r.text() }; }, url);
    const out = { ok: true, status: text.status, length: text.text.length };
    if (grep) {
      const re = new RegExp(grep, 'gi'); const snippets = []; let m;
      while ((m = re.exec(text.text)) && snippets.length < maxSnippets) { snippets.push({ at: m.index, snippet: text.text.slice(Math.max(0, m.index - context), m.index + context) }); if (m.index === re.lastIndex) re.lastIndex++; }
      out.snippets = snippets;
    } else out.text = text.text.slice(0, maxText);
    return out;
  } catch (err) {
    return { ok: false, status: 'fetch_failed', error: serializeError(err) };
  }
}

// ---- Customer lookup (phone or email) --------------------------------------------
// Drives the portal's own "Let's Get Started" screen (Email or Phone Number -> LET'S GO) in a
// throwaway session so the caller's main session stays parked on the guest path. The result is
// read from the portal's CustSearch reply as captured on the wire: retCode 1004 means no
// account; anything else is mined for name / email / vehicles. The found-account UI branch is
// not driven (the walker keeps using the mapped guest path); the record only personalizes the
// call and pre-fills the vehicle.
const PORTAL_MODELS = ['Accord Sedan', 'Accord Hybrid', 'Civic Sedan', 'Civic Hatchback', 'Civic Si', 'Civic Type R', 'Civic Sedan Hybrid', 'Civic Hatchback Hybrid', 'Civic Coupe', 'CR-V Hybrid', 'CR-V EFCEV', 'CR-V', 'Pilot', 'HR-V', 'Passport', 'Odyssey', 'Ridgeline', 'Prologue', 'Prelude', 'Fit', 'Insight', 'Clarity'];
const AMBIGUOUS_MODELS = ['Accord', 'Civic', 'CR-V'];

function normalizePortalModel(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return { model: '', needs_variant: false };
  const up = s.toUpperCase();
  const hybrid = /HYBRID|HYB\b/.test(up);
  if (/ACCORD/.test(up)) {
    if (hybrid) return { model: 'Accord Hybrid', needs_variant: false };
    if (/SDN|SEDAN/.test(up)) return { model: 'Accord Sedan', needs_variant: false };
    return { model: 'Accord', needs_variant: true };
  }
  if (/CR-?V/.test(up)) return hybrid ? { model: 'CR-V Hybrid', needs_variant: false } : { model: 'CR-V', needs_variant: true };
  if (/CIVIC/.test(up)) {
    if (/TYPE\s*R/.test(up)) return { model: 'Civic Type R', needs_variant: false };
    if (/\bSI\b/.test(up)) return { model: 'Civic Si', needs_variant: false };
    if (/HATCH/.test(up)) return { model: hybrid ? 'Civic Hatchback Hybrid' : 'Civic Hatchback', needs_variant: false };
    if (/SDN|SEDAN/.test(up)) return { model: hybrid ? 'Civic Sedan Hybrid' : 'Civic Sedan', needs_variant: false };
    if (/COUPE|CPE/.test(up)) return { model: 'Civic Coupe', needs_variant: false };
    return { model: 'Civic', needs_variant: true };
  }
  for (const m of PORTAL_MODELS) if (up.includes(m.toUpperCase())) return { model: m, needs_variant: false };
  return { model: s, needs_variant: false, unmapped: true };
}

// Walk an arbitrary JSON payload and pull out the fields a DMS customer record tends to carry.
function mineCustomerRecord(payload) {
  const out = { first_name: '', last_name: '', email: '', phone: '', vehicles: [] };
  const pick = (obj, res) => { for (const k of Object.keys(obj)) { if (res.some(r => r.test(k)) && typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim(); } return ''; };
  const seenVeh = new Set();
  const visit = (node, depth) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) { node.forEach(n => visit(n, depth + 1)); return; }
    if (typeof node !== 'object') return;
    const keys = Object.keys(node);
    const hasYear = keys.some(k => /^(model)?year$|^yr$|modelyear/i.test(k));
    const hasModel = keys.some(k => /^model(name|desc|description)?$|^mdl/i.test(k));
    if (hasYear && hasModel) {
      const year = pick(node, [/^(model)?year$/i, /^yr$/i, /modelyear/i]) || String(node.year || node.modelYear || node.ModelYear || '');
      const make = pick(node, [/^make(name|desc)?$/i, /^mk$/i]);
      const model = pick(node, [/^model(name|desc|description)?$/i, /^mdl/i]);
      const vin = pick(node, [/^vin$/i]);
      const key = `${year}|${make}|${model}|${vin}`;
      if (!seenVeh.has(key) && (year || model)) { seenVeh.add(key); out.vehicles.push({ year: String(year).slice(0, 4), make, model, vin: vin ? vin.slice(-6) : '' }); }
    }
    if (!out.first_name) out.first_name = pick(node, [/^first(_)?name$/i, /^fname$/i, /^firstnm$/i]);
    if (!out.last_name) out.last_name = pick(node, [/^last(_)?name$/i, /^lname$/i, /^lastnm$/i, /^surname$/i]);
    if (!out.email) out.email = pick(node, [/^e-?mail(address)?$/i]);
    if (!out.phone) out.phone = pick(node, [/^(cell|mobile|home|primary)?phone(number|no)?$/i, /^phone1$/i]);
    for (const k of keys) visit(node[k], depth + 1);
  };
  visit(payload, 0);
  return out;
}

export async function lookupCustomer({ phone, email } = {}) {
  const t0 = Date.now();
  const digits = String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const query = digits.length === 10 ? digits : String(email || '').trim();
  if (!query) return { ok: false, success: false, status: 'missing_phone_or_email', found: false };
  const got = await acquireSession();
  if (got.error) return { ok: false, success: false, status: 'session_start_failed', found: false, error: got.error.error };
  const session = got.session;
  const page = session.page;
  const trace = [];
  const note = (screen, extra) => trace.push({ t: Date.now() - t0, screen, ...(extra || {}) });
  const frameText = async () => (await getReynoldsFrame(page)).evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
  const has = (t, needle) => t.toLowerCase().includes(String(needle).toLowerCase());
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    let t = await frameText();
    if (!has(t, 'Email or Phone Number')) {
      if (has(t, 'Schedule your service appointment')) {
        await applyStep(page, { type: 'clickText', pattern: 'Schedule Appointment', pick: 'shortest' });
        for (let i = 0; i < 25 && !has(t, 'Email or Phone Number'); i++) { await sleep(200); t = await frameText(); }
      }
      if (!has(t, 'Email or Phone Number')) { note('entry', { failed: true, text: t.slice(0, 200) }); return { ok: false, success: false, status: 'lookup_screen_not_found', found: false, elapsed_ms: Date.now() - t0, trace }; }
    }
    note('lookup_screen');
    const before = session.network.length;
    let r = await applyStep(page, { type: 'fill', selector: '#phoneEmail_input', value: query });
    if (r.ok === false) { note('fill', r); return { ok: false, success: false, status: 'phone_field_not_found', found: false, elapsed_ms: Date.now() - t0, trace }; }
    r = await applyStep(page, { type: 'clickText', pattern: "^LET'S GO$" });
    if (r.ok === false) { note('go', r); return { ok: false, success: false, status: 'lets_go_not_found', found: false, elapsed_ms: Date.now() - t0, trace }; }
    let entry = null;
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      entry = session.network.slice(before).find(e => /"command"\s*:\s*"CustSearch"/.test(e.postData || '') && e.body);
      if (entry) break;
      await sleep(120);
    }
    if (!entry) { note('no_cust_search_reply', { text: (await frameText()).slice(0, 200) }); return { ok: false, success: false, status: 'lookup_timeout', found: false, elapsed_ms: Date.now() - t0, trace }; }
    let payload = null;
    try { payload = JSON.parse(entry.body); } catch (_e) { payload = null; }
    const app = payload && payload.APP ? payload.APP : payload;
    const retCode = String(app && app.retCode != null ? app.retCode : '');
    const errMsg = String(app && app.errMsg ? app.errMsg : '');
    note('cust_search', { retCode, errMsg: errMsg.slice(0, 80), bodyLen: String(entry.body || '').length });
    if (retCode === '1004' || /not found/i.test(errMsg)) {
      return { ok: true, success: true, found: false, status: 'not_found', query_type: digits.length === 10 ? 'phone' : 'email', elapsed_ms: Date.now() - t0, trace };
    }
    if (retCode && retCode !== '0' && retCode !== '200' && errMsg) {
      return { ok: false, success: false, found: false, status: 'portal_error', ret_code: retCode, message: errMsg.slice(0, 200), elapsed_ms: Date.now() - t0, trace };
    }
    const rec = mineCustomerRecord(app);
    const vehicles = rec.vehicles.map(v => { const n = normalizePortalModel(v.model); return { ...v, portal_model: n.model, needs_variant: n.needs_variant, unmapped: Boolean(n.unmapped) }; });
    const vehicle_summary = vehicles.map(v => [v.year, v.make || 'Honda', v.portal_model].filter(Boolean).join(' ')).join(' and ');
    const first = vehicles[0] || null;
    console.log(JSON.stringify({ event: 'customer_lookup_found', keys: app && typeof app === 'object' ? Object.keys(app).slice(0, 40) : [], vehicles: vehicles.length, hasName: Boolean(rec.first_name), raw: JSON.stringify(app).slice(0, 4000) }));
    return {
      ok: true, success: true, found: true, status: 'found',
      first_name: rec.first_name, last_name: rec.last_name, customer_name: [rec.first_name, rec.last_name].filter(Boolean).join(' '),
      email: rec.email, phone: rec.phone || digits,
      vehicle_count: vehicles.length, vehicles, vehicle_summary,
      vehicle_year: vehicles.length === 1 && first ? first.year : '',
      vehicle_model: vehicles.length === 1 && first && !first.needs_variant && !first.unmapped ? first.portal_model : '',
      vehicle_needs_variant: vehicles.length === 1 && first ? Boolean(first.needs_variant || first.unmapped) : vehicles.length > 1,
      elapsed_ms: Date.now() - t0, trace
    };
  } catch (err) {
    return { ok: false, success: false, found: false, status: 'lookup_exception', error: serializeError(err), elapsed_ms: Date.now() - t0, trace };
  } finally {
    sessions.delete(session.id);
    session.browser?.close().catch(() => {});
    poolTopUp();
  }
}

export async function getSessionNetwork(id, since = 0) {
  const session = sessions.get(id);
  if (!session) return { ok: false, status: 'session_not_found' };
  const entries = (session.network || []).slice(Number(since) || 0);
  let cookies = [];
  try { cookies = (await session.context.cookies()).map(c => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, valueLen: String(c.value || '').length, valuePrefix: String(c.value || '').slice(0, 12) })); } catch (_e) {}
  return { ok: true, id, count: entries.length, total: (session.network || []).length, cookies, entries };
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
