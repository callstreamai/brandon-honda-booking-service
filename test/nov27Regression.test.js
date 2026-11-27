import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverEmail} from '../src/emailRecovery.js';
import {policyDecision} from '../src/policy.js';
import {schedulingDecision} from '../src/schedulingResume.js';
const base={contact_contract_version:3,upfront_intake:true,completion_fallbacks:true};
test('usable caller spelling is saved without a verification turn; explicit correction replaces it',async()=>{
 const first=await recoverEmail({...base,call_id:'nov27-correction',utterance:'B I L M A nine two at gmail dot com.'},{});
 assert.equal(first.customer_email,'bilma92@gmail.com');assert.equal(first.email_helper_status,'accepted');assert.equal(first.email_question,'');assert.equal(first.email_confirmed,true);
 const second=await recoverEmail({...base,call_id:'nov27-correction',previous_email:first.customer_email,utterance:'B I L M A at a l p h a d r i v e a i dot com.'},{});
 assert.equal(second.customer_email,'bilma@alphadriveai.com');assert.equal(second.email_resume_node,'policy_hook');
});
test('partial address retains local part when caller supplies domain next turn',async()=>{
 const a=await recoverEmail({...base,call_id:'nov27-fragment',utterance:'B I L M A nine two at G M A'},{});
 assert.equal(a.email_helper_status,'clarify');
 const b=await recoverEmail({...base,call_id:'nov27-fragment',utterance:'gmail dot com.'},{});
 assert.equal(b.customer_email,'bilma92@gmail.com');assert.equal(b.email_helper_status,'accepted');
});
test('email refusal offers existing service assistance without repeated verification',async()=>{
 for(const utterance of ["I don't have an email.","I just don't want to provide anything.",'Skip the email.']){
  const r=await recoverEmail({...base,call_id:'decline-'+utterance,utterance},{});assert.equal(r.email_helper_status,'required_unavailable');assert.equal(r.customer_email,'none');
 }
});
test('pickup, delivery and valet route to Service before customer collection',()=>{
 for(const transport_option of ['pickup','pick-up and delivery','valet','delivery']){
  const i={...base,transport_option};assert.equal(policyDecision(i).target,'service');assert.equal(schedulingDecision(i,policyDecision(i)).next_step,'dial_service');
 }
});
test('onsite transportation prompt no longer offers online pickup or valet',()=>{
 const i={...base,customer_account_type:'individual',customer_name:'Vince Test',caller_phone:'4102790548',caller_phone_confirmed:true,vehicle_year:'2021',vehicle_make:'Ford',vehicle_model:'Bronco',vehicle_type:'Gas',vehicle_mileage:'25000',customer_email:'vince@example.com',email_confirmed:true,service_concern:'oil change',service_complete:true};
 const r=schedulingDecision(i,policyDecision(i));assert.equal(r.next_step,'transport_option');assert.equal(r.step_question,'Would you prefer to wait or drop off?');
});
