import test from 'node:test';
import assert from 'node:assert/strict';
import {pathwayRecoveryResult,recoverPathway} from '../src/pathwayRecovery.js';
const advice=resume_node=>({resume_node,advice:'Use known information and clarify only the missing detail.',question:null});
const state={customer_account_type:'individual',customer_name:'Vince Test',caller_phone:'4102790548',customer_email:'test@example.com',email_confirmed:true,vehicle_year:'2026',vehicle_make:'Ford',vehicle_model:'Maverick',vehicle_type:'Gas',service_concern:'oil change',transport_option:'dropoff',preferred_date:'2026-11-19',preferred_time:'8:00 a.m.',sms_consent:false,readback_confirmed:false,pickup_address:'23 Example Street',pickup_access:'Call on arrival',request_notes:'Preserve these notes',change_request_fingerprint:'original'};
test('every allowed recovery preserves input and never returns customer fields or permissions',()=>{
 for(const source of ['contact_name','account_phone','vehicle_year','contact_email','service_need','transport_option','date_preference','valet_details','readback','existing_request']){
  const b={source_node:source,state:structuredClone(state)},before=structuredClone(b);
  const r=pathwayRecoveryResult(b,{...advice(source),recovered_state:{customer_name:'wrong',readback_confirmed:true},appointment_id:'fake'});
  assert.deepEqual(b,before);assert.deepEqual(Object.keys(r).sort(),['success','recovery_resume_node','recovery_advice','recovery_question','recovery_needed','recovery_status'].sort());
 }
});
test('known fields advance without re-collecting',()=>{
 for(const [source,target]of [['account_phone','vehicle_year'],['vehicle_year','contact_email'],['contact_email','contact_confirmation'],['transport_option','policy_hook'],['date_preference','policy_hook']])assert.equal(pathwayRecoveryResult({source_node:source,state},advice(source)).recovery_resume_node,target);
});
test('existing requests stay in their flow and cannot send or bypass renewed review',()=>{
 const b={source_node:'change_request_readback',state:{...state,existing_action:'reschedule',existing_appointment:'November 23 9 AM',requested_change:'November 24 10 AM'}};
 assert.equal(pathwayRecoveryResult(b,advice('vehicle_year')).recovery_resume_node,'prepare_change_request');
 assert.equal(pathwayRecoveryResult({...b,source_node:'transport_option'},advice('change_request_readback')).recovery_resume_node,'prepare_change_request');
 assert.equal(pathwayRecoveryResult(b,advice('pathway_recovery_help')).recovery_resume_node,'pathway_recovery_help');
 b.state.change_email_status='request_sent';assert.equal(pathwayRecoveryResult(b,advice('existing_request')).recovery_resume_node,'end_change_request_sent');
});
test('unknown writes cannot retry and direct write/transfer targets are rejected',()=>{
 assert.equal(pathwayRecoveryResult({state:{booking_status:'booking_timeout_unknown'}},advice('readback')).recovery_resume_node,'pathway_recovery_help');
 assert.equal(pathwayRecoveryResult({state:{booking_status:'booked'}},advice('readback')).recovery_resume_node,'pathway_recovery_help');
 for(const target of ['submit_booking','send_change_request','cancel_commit','dial_service','transfer_advisor'])assert.throws(()=>pathwayRecoveryResult({},advice(target)));
});
test('model input is redacted, output bounded and repeated recovery offers help',async()=>{
 let count=0;const env={EXTERNAL_RECOVERY_ENABLED:'true',OPENAI_API_KEY:'fake',OPENAI_MODEL:'fake'};
 const fetcher=async(u,o)=>{count++;const p=JSON.parse(o.body);assert.equal(p.store,false);assert.ok(!p.input.includes('4102790548'));assert.equal(JSON.parse(p.input).state.vehicle_model,'Maverick');return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(advice('transport_option'))}]}]})};};
 const b={call_id:'whole-recovery-unit',source_node:'transport_option',utterance:'That is wrong; I already told you drop off',state:structuredClone(state)};
 assert.equal((await recoverPathway(b,env,fetcher)).recovery_resume_node,'policy_hook');await recoverPathway(b,env,fetcher);
 assert.equal((await recoverPathway(b,env,fetcher)).recovery_resume_node,'pathway_recovery_help');assert.equal(count,2);assert.deepEqual(b.state,state);
});
test('model failure never clears data or grants permission',async()=>{
 const r=await recoverPathway({call_id:'whole-error',source_node:'readback',utterance:'That is still wrong',state},{EXTERNAL_RECOVERY_ENABLED:'true',OPENAI_API_KEY:'fake',OPENAI_MODEL:'fake'},async()=>{throw Error('offline')});
 assert.equal(r.recovery_resume_node,'pathway_recovery_help');assert.equal(r.readback_confirmed,undefined);assert.equal(r.recovered_state,undefined);
});

test('known callback advances without an LLM and preserves details and permissions',async()=>{
 const body={call_id:'known-phone-fast',source_node:'account_phone',utterance:'I already told you the calling number is best',state:structuredClone(state)};
 const before=structuredClone(body);
 const r=await recoverPathway(body,{},async()=>{throw Error('must not call model')});
 assert.equal(r.recovery_resume_node,'contact_confirmation');assert.deepEqual(body,before);assert.equal(r.caller_phone,undefined);assert.equal(r.readback_confirmed,undefined);
});
test('recovery skips every known intake field but stops before tools and never grants consent',async()=>{
 const s={...state,confirmation_method:'both',vehicle_mileage:'25000'};
 const r=await recoverPathway({call_id:'known-chain',source_node:'account_phone',utterance:'I already answered that twice',state:s},{},async()=>{throw Error('must not call model')});
 assert.equal(r.recovery_resume_node,'prepare_hook');assert.equal(r.readback_confirmed,undefined);assert.equal(r.request_confirmed,undefined);
 const missing={...s,vehicle_type:null};
 const m=await recoverPathway({call_id:'missing-fuel-chain',source_node:'account_phone',utterance:'I already answered that twice',state:missing},{},async()=>{throw Error('must not call model')});
 assert.equal(m.recovery_resume_node,'fuel_type');
});
test('correction cannot bypass interpretation using stale known data',async()=>{
 const r=await recoverPathway({call_id:'known-phone-correct',source_node:'account_phone',utterance:'Actually that is the wrong phone number',state},{},async()=>{throw Error('offline')});
 assert.equal(r.recovery_resume_node,'pathway_recovery_help');
});
