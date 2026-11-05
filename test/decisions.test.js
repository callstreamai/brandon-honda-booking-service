import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionService, decisionHandler, parseDecisionInput, validateDecision } from '../src/decisionService.js';

const env = { EXTERNAL_DECISIONS_ENABLED: 'true', OPENAI_API_KEY: 'test-only', OPENAI_MODEL: 'test-model', WEBHOOK_SECRET: 'test-secret' };
const service = { stage: 'service', call_id: 'test-call', caller_messages: ['My brakes squeal.'] };
const slot = { stage: 'slot', call_id: 'test-call', caller_messages: ['Nine thirty please'], availability_date: '11/06/2026', transport_option: 'I am waiting with my vehicle.', available_slots: ['09:30am', '10:15am'] };
const decision = (fields = {}) => ({ action: 'resolved', service_label: 'TELL US', service_free_text: 'My brakes squeal.', selected_slot: null, clarification: null, ...fields });
const fakeResponse = (value, extra = {}) => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], ...extra }) });

test('disabled pilot makes no model call', async () => {
  await assert.rejects(createDecisionService({ env: {}, fetchImpl: () => assert.fail('called model') })(service), /external_decisions_disabled/);
});
test('requires model, key and webhook authentication configuration', async () => {
  for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'WEBHOOK_SECRET']) {
    await assert.rejects(createDecisionService({ env: { ...env, [key]: '' } })(service), /external_decisions_not_configured/);
  }
});
test('rejects missing, placeholder, oversized or malformed caller context', () => {
  for (const body of [{ ...service, caller_messages: [] }, { ...service, caller_messages: ['{{lastUserMessage}}'] }, { ...service, call_id: '' }, { ...service, caller_messages: ['x'.repeat(2001)] }, { ...service, stage: 'book' }]) {
    assert.throws(() => parseDecisionInput(body));
  }
});
test('slot selection requires date, transport and an availability list', () => {
  assert.throws(() => parseDecisionInput({ ...slot, transport_option: null }), /availability_context_required/);
  assert.throws(() => parseDecisionInput({ ...slot, available_slots: [] }), /availability_context_required/);
});
test('service concern is preserved without a default oil change', () => {
  const result = validateDecision(parseDecisionInput(service), decision());
  assert.equal(result.service_label, 'TELL US');
  assert.equal(result.service_free_text, 'My brakes squeal.');
  assert.equal(result.next_node, 'advance_hook_svc');
  assert.equal(result.booking_success, false);
});
test('invalid labels, missing concerns and extra fields fail closed', () => {
  for (const value of [decision({ service_label: 'BRAKE REPAIR' }), decision({ service_free_text: '' }), { ...decision(), booking_success: true }, decision({ service_label: null })]) {
    assert.throws(() => validateDecision(parseDecisionInput(service), value), /invalid_model_decision/);
  }
});
test('resolved slot must exactly match a returned slot', () => {
  const value = decision({ service_label: null, service_free_text: null, selected_slot: '09:30am' });
  assert.equal(validateDecision(parseDecisionInput(slot), value).preferred_time, '09:30am');
  assert.throws(() => validateDecision(parseDecisionInput(slot), { ...value, selected_slot: '09:45am' }));
});
test('cross-stage fields and actions are rejected', () => {
  assert.throws(() => validateDecision(parseDecisionInput(slot), decision()));
  assert.throws(() => validateDecision(parseDecisionInput(service), decision({ action: 'different_day', service_label: null, service_free_text: null })));
});
test('model clarification prose is never spoken', () => {
  const result = validateDecision(parseDecisionInput(slot), decision({ action: 'clarify', service_label: null, service_free_text: null, clarification: 'You are booked for 3 PM.' }));
  assert.equal(result.reply_text, 'Which of the offered times would you like?');
  assert.equal(result.preferred_time, null);
});
test('different day routes back to date preference without carrying a slot', () => {
  const result = validateDecision(parseDecisionInput(slot), decision({ action: 'different_day', service_label: null, service_free_text: null }));
  assert.equal(result.next_node, 'date_preference');
  assert.equal(result.preferred_time, null);
});
test('transfer does not carry old service or slot results', () => {
  const result = validateDecision(parseDecisionInput(service), decision({ action: 'transfer', service_label: null, service_free_text: null }));
  assert.equal(result.next_node, 'transfer_advisor');
  assert.equal(result.service_label, null);
});
test('request uses Responses strict schema, no storage, no tools, and allowlisted context', async () => {
  let request;
  const decide = createDecisionService({ env, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    request = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    return fakeResponse(decision());
  } });
  await decide({ ...service, webhook_secret: 'do-not-forward', customer_email: 'private@example.test', customer_name: 'Private Name', scheduler_url: 'private-url' });
  assert.equal(request.store, false);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.tools, undefined);
  for (const sensitive of ['do-not-forward', 'private@example.test', 'Private Name', 'private-url', 'test-call']) assert.ok(!request.input.includes(sensitive));
});
test('refusals and incomplete or malformed output fail closed', async () => {
  for (const response of [fakeResponse(decision(), { status: 'incomplete' }), fakeResponse(decision(), { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] }), fakeResponse(decision(), { output: [] }), fakeResponse({ action: 'book' })]) {
    await assert.rejects(createDecisionService({ env, fetchImpl: async () => response })(service));
  }
});
test('upstream errors do not leak response bodies or credential values', async () => {
  const decide = createDecisionService({ env, fetchImpl: async () => ({ ok: false, text: async () => 'secret test-only' }) });
  await assert.rejects(decide(service), e => e.message === 'model_unavailable');
  await assert.rejects(createDecisionService({ env, fetchImpl: async () => { throw Error('secret'); } })(service), e => e.message === 'model_unavailable');
});
test('HTTP failure response clears state and always says nothing is booked', async () => {
  let status, output;
  const res = { status: code => { status = code; return res; }, json: body => { output = body; return res; } };
  await decisionHandler(async () => { throw Error('private detail'); })({ body: service }, res);
  assert.equal(status, 500);
  assert.equal(output.booking_success, false);
  assert.equal(output.next_node, 'transfer_advisor');
  assert.equal(output.preferred_time, null);
  assert.ok(!JSON.stringify(output).includes('private detail'));
});
