// Standalone host: deliberately excludes every scheduler/browser/booking module.
import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRecoveryService } from './recoveryService.js';
import { DecisionError } from './decisionService.js';

export function createRecoveryServer({ env = process.env, decide = createRecoveryService({ env }) } = {}) {
  const episodes = new Map();
  return http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const failure = (status, recovery_status) => send(status, { success: false, recovery_status, recovery_action: 'transfer', next_node: 'transfer_advisor', booking_success: false });
    const path = req.url?.split('?')[0];
    if (req.method === 'GET' && path === '/health') return send(200, { ok: true, service: 'brandon-honda-recovery-helper', booking_routes: false, configured: Boolean(env.OPENAI_API_KEY && env.OPENAI_MODEL && env.WEBHOOK_SECRET), enabled: env.EXTERNAL_RECOVERY_ENABLED === 'true' });
    if (req.method !== 'POST' || path !== '/conversation/help') return failure(404, 'not_found');
    if (!env.WEBHOOK_SECRET) return failure(503, 'auth_not_configured');
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${env.WEBHOOK_SECRET}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return failure(401, 'unauthorized');
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return failure(415, 'json_required');
    let raw = '', bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32768) { failure(413, 'request_too_large'); req.resume(); return; }
        raw += chunk.toString('utf8');
      }
      const body = JSON.parse(raw);
      // Match Bland's unset-variable convention without retaining credentials in context.
      const scrub = v => typeof v === 'string' && /^\s*\{\{[^}]*\}\}\s*$/.test(v) ? null
        : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v;
      const input = scrub(body);
      if (!input || typeof input.call_id !== 'string' || !input.call_id.trim() || input.call_id.length > 128) return failure(400, 'call_id_required');
      const now = Date.now();
      for (const [key, value] of episodes) if (now - value.created > 30 * 60 * 1000 && !value.pending) episodes.delete(key);
      if (!episodes.has(input.call_id) && episodes.size >= 500) return failure(503, 'capacity_limit');
      const episode = episodes.get(input.call_id) || { count: 0, created: now, cache: new Map() };
      episodes.set(input.call_id, episode);
      const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      // Retry of an identical request does not make another model call.
      if (episode.cache.has(digest)) return send(200, episode.cache.get(digest));
      if (episode.pending) return failure(409, 'recovery_in_progress');
      if (episode.count >= 2) return failure(429, 'recovery_limit');
      episode.pending = true;
      episode.count++;
      try {
        const result = await decide(input);
        const recovered_state = { ...(input.state || {}) };
        for (const field of result.clear_fields || []) recovered_state[field] = null;
        const output = { ...result, recovered_state };
        episode.cache.set(digest, output);
        return send(200, output);
      } finally { episode.pending = false; }
    } catch (error) {
      return failure(error instanceof DecisionError ? error.status : error instanceof SyntaxError ? 400 : 500,
        error instanceof DecisionError ? error.code : error instanceof SyntaxError ? 'invalid_json' : 'recovery_failed');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createRecoveryServer();
  server.requestTimeout = 35000;
  server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log('Recovery helper listening; no booking routes enabled.'));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
