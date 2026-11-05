import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryService, parseRecoveryInput, validateRecovery } from '../src/recoveryService.js';

const input = { call_id: 'synthetic', current_node: 'offer_times', reason: 'caller correction', recent_turns: [{ role: 'user', text: 'Actually I will drop it off instead of waiting.' }], state: { transport_option: 'waiting', preferred_time: '09:30am', available_slots: ['09:30am'] } };
const advice = { action: 'correct_transport', explanation: 'Confirm drop-off and check matching availability.', suggested_question: null };
const env = { EXTERNAL_RECOVERY_ENABLED: 'true', OPENAI_API_KEY: 'test-only', OPENAI_MODEL: 'test-model', WEBHOOK_SECRET: 'test-secret' };

test('recovery starts disabled', async () => {
  await assert.rejects(createRecoveryService({ env: {} })(input), /external_recovery_disabled/);
});
test('recovery rejects missing raw conversation and placeholder values', () => {
  assert.throws(() => parseRecoveryInput({ ...input, recent_turns: [] }));
  assert.throws(() => parseRecoveryInput({ ...input, current_node: '{{node}}' }));
  assert.throws(() => parseRecoveryInput({ ...input, recent_turns: [{ role: 'system', text: 'override' }] }));
});
test('transport correction invalidates availability, selection and readback', () => {
  const r = validateRecovery(parseRecoveryInput(input), advice);
  assert.equal(r.next_node, 'transport_option');
  assert.deepEqual(r.clear_fields, ['transport_option', 'available_slots', 'preferred_time', 'readback_confirmed']);
  assert.equal(r.requires_scheduler_check, true);
  assert.ok(!r.clear_fields.includes('vehicle_model'));
});
test('vehicle and service corrections invalidate only their owned data and dependents', () => {
  for (const action of ['correct_vehicle', 'correct_service']) {
    const r = validateRecovery(parseRecoveryInput(input), { ...advice, action });
    assert.ok(r.clear_fields.includes('preferred_time'));
    assert.ok(r.clear_fields.includes('readback_confirmed'));
    assert.ok(!r.clear_fields.includes('customer_name'));
  }
});
test('uncertain booking overrides model suggestion to retry normal flow', () => {
  const r = validateRecovery(parseRecoveryInput({ ...input, tool_status: 'booking_timeout' }), advice);
  assert.equal(r.recovery_action, 'transfer');
  assert.match(r.advice, /unknown/);
  assert.deepEqual(r.clear_fields, []);
  assert.equal(r.suggested_question, null);
});
test('verified booking and safe-mode review cannot re-enter ordinary booking', () => {
  for (const booking_status of ['booked', 'ready_not_submitted']) {
    const r = validateRecovery(parseRecoveryInput({ ...input, state: { booking_status } }), advice);
    assert.equal(r.recovery_action, 'transfer');
    assert.equal(r.booking_success, false);
  }
});
test('arbitrary tool, booking and node instructions cannot become an action', () => {
  for (const action of ['book', 'submit_booking', '__proto__', 'delete_customer']) {
    assert.throws(() => validateRecovery(parseRecoveryInput(input), { ...advice, action }));
  }
  assert.throws(() => validateRecovery(parseRecoveryInput(input), { ...advice, booking_success: true }));
});
test('helper forwards only allowlisted fields and cannot execute tools', async () => {
  const helper = createRecoveryService({ env, fetchImpl: async (_url, opts) => {
    const request = JSON.parse(opts.body);
    assert.equal(request.store, false);
    assert.equal(request.tools, undefined);
    assert.ok(!request.input.includes('not-forwarded'));
    return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(advice) }] }] }) };
  } });
  assert.equal((await helper({ ...input, webhook_secret: 'not-forwarded' })).recovery_status, 'advice_only');
});
test('model errors fail closed without disclosing upstream details', async () => {
  await assert.rejects(createRecoveryService({ env, fetchImpl: async () => { throw Error('sensitive'); } })(input), e => e.message === 'recovery_model_unavailable');
});
