import {contactCorrection} from '../src/contactCorrection.js';
import {completionDefaults} from '../src/responseValues.js';
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

test('actual Nov27 local-part words reuse the already supplied Gmail domain',async()=>{
 await recoverEmail({...base,call_id:'nov27-domain-first',utterance:'gmail.com.'},{});
 const r=await recoverEmail({...base,call_id:'nov27-domain-first',utterance:'Bilma nine two at Gmail'},{});
 assert.equal(r.customer_email,'bilma92@gmail.com');assert.equal(r.email_helper_status,'accepted');
});

test('a full spoken email correction during fuel intake reaches the email owner',async()=>{
 const r=await contactCorrection({...base,call_id:'nov27-cross-node',intake_field:'vehicle_type',customer_email:'bilmo92@gmail.com',last_user_message:"It's B I L M A nine two at gmail dot com."},{});
 assert.equal(r.customer_email,'bilma92@gmail.com');assert.equal(r.email_helper_status,'accepted');
});

test('completed email resets clarification budget; framed literal correction still saves immediately',async()=>{
 const call_id='nov27-budget';
 for(const utterance of ['fragment','fragment two','fragment three'])await recoverEmail({...base,call_id,utterance},{});
 await recoverEmail({...base,call_id,utterance:'B I L M A nine two at gmail dot com'},{});
 const r=await recoverEmail({...base,call_id,previous_email:'bilma92@gmail.com',utterance:'For this test, please change the email to vince@callstreamai.com.'},{});
 assert.equal(r.customer_email,'vince@callstreamai.com');assert.equal(r.email_helper_status,'accepted');
});

test('email tool output is not mistaken for a failed answer to the fuel question',()=>{
 const i={...base,customer_account_type:'individual',customer_name:'Vince Test',caller_phone:'4102790548',caller_phone_confirmed:true,vehicle_year:'2021',vehicle_make:'Ford',vehicle_model:'Bronco',customer_email:'vince@example.com',email_confirmed:true,intake_field:'vehicle_type',last_user_message:'<<< BEGIN AUTO-GENERATED-CONTENT >>> email accepted'};
 assert.equal(schedulingDecision(i,policyDecision(i)).intake_field,'vehicle_type');
});

test('an incomplete alternate phone is not overwritten by ANI or allowed past collection',()=>{
 const common={...base,customer_account_type:'individual',customer_name:'Vince Test',caller_id:'+14102790548',caller_phone_confirmed:true,intake_field:'caller_phone'};
 for(const caller_phone of ['239','239382']){
  const i=completionDefaults({...common,caller_phone});
  assert.equal(i.caller_phone,caller_phone);assert.equal(i.caller_phone_confirmed,false);
  const next=schedulingDecision(i,policyDecision(i));assert.equal(next.intake_field,'caller_phone');assert.match(next.step_question,/remaining digits/);
 }
 const i=completionDefaults({...common,caller_phone_confirmed:false,caller_phone:'239-382-2414',last_user_message:'2414.'});
 assert.equal(i.caller_phone,'2393822414');assert.equal(i.caller_phone_confirmed,true);
 assert.equal(schedulingDecision(i,policyDecision(i)).intake_field,'vehicle_identity');
});
