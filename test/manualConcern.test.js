import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveServices} from '../src/serviceRecovery.js';
import {concernMatches,selectManualConcern,verifyManualConcernReview} from '../src/manualConcern.js';
import {inputFingerprint,policyDecision} from '../src/policy.js';
import {searchKey} from '../src/availabilityPrefetch.js';
const menu=['The Works®','Oil Change','Brakes','Wheel Alignment'];
const noModel=()=>{throw new Error('Manual description must not call OpenAI');};
test('unmatched and mixed concerns use observed manual diagnosis rather than an approximate repair',async()=>{
 for(const service_concern of ['Engine rattles on cold starts','The brakes squeak when stopping','Oil change and the air conditioning blows hot','I do not know what it needs; it vibrates']){
  const input={call_id:'manual-test',service_concern,completion_fallbacks:true};
  const r=await resolveServices(input,menu,{},noModel,{manualConcern:true});
  assert.equal(r.status,'services_resolved');assert.equal(r.service_recovery_action,'manual_description');assert.deepEqual(r.service_labels,['General Diagnosis']);
  assert.equal(input.service_concern,service_concern);
 }
});
test('exact maintenance keeps its usual service and browser capability cannot be supplied by caller',async()=>{
 assert.deepEqual((await resolveServices({service_concern:'oil change'},menu,{},noModel,{manualConcern:true})).service_labels,['Oil Change']);
 assert.deepEqual((await resolveServices({service_concern:'Brakes'},menu,{},noModel,{manualConcern:true})).service_labels,['Brakes']);
 assert.notEqual((await resolveServices({call_id:'no-manual',service_concern:'rattling',manualConcern:true},menu,{},noModel)).service_recovery_action,'manual_description');
});
test('the final review cannot accept an older saved diagnostic description after a correction',async()=>{
 assert.equal(await verifyManualConcernReview({manualConcern:'The brakes squeak',page:{}},{service_concern:'The brakes are fine; the engine rattles'}),false);
});
test('correcting concern invalidates browser and prefetch state even with stale service labels',()=>{
 const original={call_id:'correction',service_labels:'General Diagnosis',service_concern:'The brakes squeak',caller_phone:'4102790548',customer_email:'vince@callstreamai.com'};
 const corrected={...original,service_concern:'The brakes are fine. The engine rattles only on cold starts.'};
 assert.notEqual(inputFingerprint(original),inputFingerprint(corrected));assert.notEqual(searchKey(original),searchKey(corrected));
 assert.equal(corrected.caller_phone,original.caller_phone);assert.equal(corrected.customer_email,original.customer_email);
 assert.equal(concernMatches(original.service_concern,corrected.service_concern),false);
});
test('Ford punctuation normalization is tolerated but losing negation or concern text is not',()=>{
 assert.ok(concernMatches('Correction: brakes are NOT squeaking. Engine rattles.','Correction brakes are NOT squeaking. Engine rattles.'));
 assert.equal(concernMatches('brakes are NOT squeaking','brakes are squeaking'),false);
 assert.equal(concernMatches('engine rattles and AC blows hot','engine rattles'),false);
});
test('long concerns cannot be silently truncated and dealer handoffs remain authoritative',async()=>{
 assert.equal((await selectManualConcern({page:{}},{service_concern:'x'.repeat(751)})).status,'service_details_required');
 for(const service_concern of ['recall service','mobile service','windshield replacement'])assert.equal(policyDecision({service_concern}).action,'handoff');
});
