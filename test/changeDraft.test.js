import test from 'node:test';
import assert from 'node:assert/strict';
import {createChangeDraftHandler} from '../src/changeDraft.js';
import {requestFingerprint} from '../src/changeRequest.js';
const input={authoritative_draft:true,call_id:'cancel-correction',existing_action:'cancel',customer_account_type:'individual',customer_name:'Vince Lamartina',caller_phone:'4102790548',vehicle_year:'2023',vehicle_make:'Ford',vehicle_model:'Explorer',existing_appointment:'November 23 at 8:30 AM',service_concern:'Oil change',customer_email:'',email_confirmed:true,request_notes:'RPA TEST'};
test('corrected date readback and delivered snapshot stay identical despite stale Bland extraction',async()=>{
 let delivered;const h=createChangeDraftHandler({interpret:async()=>({existing_appointment:'November 24 at 9:30 AM'}),send:async i=>{delivered=i;return {status:'request_sent'};}});
 const initial=await h({...input,prepare_only:true});
 const corrected=await h({...input,prepare_only:true,correction_utterance:'Actually November twenty fourth, nine thirty AM.'});
 assert.match(corrected.request_summary,/November 24th at 9:30 AM/);assert.notEqual(corrected.request_fingerprint,initial.request_fingerprint);
 await h({...input,request_confirmed:true,confirmed_fingerprint:corrected.request_fingerprint});
 assert.equal(delivered.existing_appointment,corrected.existing_appointment);assert.equal(requestFingerprint(delivered),corrected.request_fingerprint);
 assert.equal(delivered.customer_name,input.customer_name);assert.equal(delivered.caller_phone,input.caller_phone);assert.equal(delivered.vehicle_model,'Explorer');assert.equal(delivered.request_notes,'RPA TEST');
});
test('failed correction never sends and leaves the prior snapshot intact',async()=>{let sends=0;const h=createChangeDraftHandler({interpret:async()=>{throw Error('timeout')},send:async()=>{sends++}});await h({...input,prepare_only:true});const r=await h({...input,prepare_only:true,correction_utterance:'wrong date'});assert.equal(r.status,'correction_unclear');assert.equal(sends,0);assert.equal((await h({...input,request_confirmed:true,correction_utterance:'wrong date'})).status,'fresh_readback_required');assert.equal(sends,0);});
test('missing server draft after restart cannot authorize a send from client variables',async()=>{const h=createChangeDraftHandler({send:async()=>{throw Error('must not send')}});assert.equal((await h({...input,request_confirmed:true,confirmed_fingerprint:requestFingerprint(input)})).status,'fresh_readback_required');});
test('correction to reschedule date and transport preserves caller identity and original appointment',async()=>{const h=createChangeDraftHandler({interpret:async()=>({requested_change:'November 25 afternoon',transport_option:'wait'})});const i={...input,existing_action:'reschedule',requested_change:'November 24 morning',transport_option:'dropoff'};await h({...i,prepare_only:true});const r=await h({...i,prepare_only:true,correction_utterance:'Make that Wednesday afternoon and I will wait.'});assert.equal(r.requested_change,'November 25 afternoon');assert.equal(r.transport_option,'wait');assert.equal(r.existing_appointment,input.existing_appointment);assert.equal(r.customer_name,input.customer_name);});
test('a correction cannot leak between callers',async()=>{const h=createChangeDraftHandler({interpret:async()=>({vehicle_model:'Maverick'})});await h({...input,prepare_only:true});await h({...input,prepare_only:true,correction_utterance:'Maverick instead'});const r=await h({...input,call_id:'other',prepare_only:true});assert.equal(r.vehicle_model,'Explorer');});
test('actual early prepare then multi-field intake preserves email and vehicle together',async()=>{
 const h=createChangeDraftHandler();
 await h({authoritative_draft:true,call_id:'early-prepare',prepare_only:true,existing_action:'cancel',customer_account_type:'individual',customer_name:'Isabelle Eft',caller_phone:'2393822414'});
 const r=await h({...input,call_id:'early-prepare',prepare_only:true,customer_name:null,caller_phone:null,vehicle_year:'2020',vehicle_make:'Ford',vehicle_model:'Bronco',customer_email:'bilma@alphadriveai.com',email_confirmed:true,existing_appointment:'November 24 at 1 PM',service_concern:'coolant and wipers'});
 assert.equal(r.status,'request_ready');assert.equal(r.customer_name,'Isabelle Eft');assert.equal(r.caller_phone,'2393822414');assert.equal(r.vehicle_model,'Bronco');assert.equal(r.customer_email,'bilma@alphadriveai.com');assert.equal(r.email_confirmed,true);
 const locked=await h({...input,call_id:'early-prepare',prepare_only:true,vehicle_model:'Focus',customer_email:'wrong@example.com'});
 assert.equal(locked.vehicle_model,'Bronco');assert.equal(locked.customer_email,'bilma@alphadriveai.com');assert.equal(locked.request_fingerprint,r.request_fingerprint);
});
