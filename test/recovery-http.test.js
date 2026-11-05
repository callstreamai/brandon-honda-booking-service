import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryServer } from '../src/recoveryServer.js';

test('HTTP helper authenticates, clears stale fields, caches retries, caps calls and excludes bookings', async () => {
  let calls = 0;
  const server = createRecoveryServer({ env: { WEBHOOK_SECRET: 'test-secret' }, decide: async () => { calls++; return { success: true, recovery_action: 'correct_transport', clear_fields: ['preferred_time', 'available_slots'], booking_success: false }; } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const input = { call_id: 'synthetic', state: { vehicle_model: 'Civic', preferred_time: '09:30am', available_slots: ['09:30am'] } };
  const post = (body, auth = 'Bearer test-secret', path = '/conversation/help') => fetch(url + path, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    assert.equal((await fetch(url + '/health')).status, 200);
    assert.equal((await post(input, 'wrong')).status, 401);
    assert.equal((await post(input, 'Bearer test-secret', '/book-service')).status, 404);
    assert.equal((await post('{bad')).status, 400);
    const first = await (await post(input)).json();
    assert.equal(first.recovered_state.vehicle_model, 'Civic');
    assert.equal(first.recovered_state.preferred_time, null);
    assert.equal(first.recovered_state.available_slots, null);
    assert.equal((await post(input)).status, 200);
    assert.equal(calls, 1);
    assert.equal((await post({ ...input, reason: 'second episode' })).status, 200);
    assert.equal((await post({ ...input, reason: 'third episode' })).status, 429);
    assert.equal(calls, 2);
  } finally { await new Promise(r => server.close(r)); }
});
