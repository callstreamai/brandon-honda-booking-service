import test from 'node:test';
import assert from 'node:assert/strict';
import {schedulingDecision} from '../src/schedulingResume.js';
import {policyDecision,inputFingerprint} from '../src/policy.js';
import {pickupCorrectionState,valetFingerprint,valetReview,applyValetAddress} from '../src/valet.js';
import {confirmedEmailState} from '../src/emailConfirmation.js';
import {recoverEmail} from '../src/emailRecovery.js';
import {bookVoiceTest} from '../src/voiceBooking.js';
const base={contact_contract_version:2,upfront_intake:true,customer_account_type:'individual',customer_name:'Isabelle Test',caller_phone:'4102790548',caller_phone_confirmed:true,vehicle_year:'2024',vehicle_make:'Lincoln',vehicle_model:'Aviator',vehicle_type:'Gas',vehicle_mileage:'unknown',customer_email:'vince@callstreamai.com',email_confirmed:true,confirmation_method:'Text',service_concern:'oil change',transport_option:'pickup',pickup_address:'19100 Fourth Avenue West, Lynnwood, Washington 98036',pickup_access:'Keys in center console',vehicle_operable:'yes',pickup_address_confirmed:true,earliest_requested:true,preferred_time:'8:30 a.m.',readback_confirmed:true};
base.pickup_confirmed_fingerprint=valetFingerprint(base);
const next=i=>schedulingDecision(i,policyDecision(i));
test('Lincoln correction invalidates old approval and slot, preserves contacts, retries the corrected address',async()=>{
 const i={...base,pickup_address:'19100 44th Avenue West, Lynnwood, Washington 98036'};
 Object.assign(i,pickupCorrectionState(i));assert.equal(i.preferred_time,'none');assert.equal(i.readback_confirmed,false);assert.equal(i.pickup_address_confirmed,false);
 assert.notEqual(inputFingerprint(i),inputFingerprint(base));assert.equal(next(i).next_step,'prepare_valet_readback');
 const review=valetReview(i);assert.match(review.valet_summary,/44th/);Object.assign(i,{pickup_confirmed_fingerprint:review.valet_review_fingerprint,pickup_address_confirmed:true});assert.equal(next(i).next_step,'availability_check');
 let filled;const options={first:()=>({waitFor:async()=>{}}),allTextContents:async()=>['19100 44th Ave W, Lynnwood WA 98036'],filter:()=>({click:async()=>{}})};
 const session={page:{locator:key=>({waitFor:async()=>{},fill:async v=>{if(key==='#address-field-input')filled=v;},isVisible:async()=>false}),getByRole:r=>r==='option'?options:{first:()=>({click:async()=>{}})}},waitForReads:async()=>{}};
 assert.equal(await applyValetAddress(session,i),null);assert.equal(filled,i.pickup_address);assert.match(session.pickupAddress,/44th/);
 for(const k of ['customer_name','caller_phone','customer_email','vehicle_make','vehicle_model','vehicle_type','pickup_access'])assert.equal(i[k],base[k]);
});
test('pickup autocomplete timeout returns an address correction, not no availability or a generic transfer',async()=>{
 const s={page:{locator:()=>({waitFor:async()=>{},fill:async()=>{}}),getByRole:()=>({first:()=>({waitFor:async()=>{const e=Error('timeout');e.name='TimeoutError';throw e;}})})}};
 const r=await applyValetAddress(s,base);assert.equal(r.status,'pickup_address_unverified');assert.match(r.step_question,/corrected/);assert.equal(r.pickup_address_confirmed,false);
});
test('required email decline cannot reach availability; caller can correct it and continue',async()=>{
 let i={...base,customer_email:'none',email_declined:true};Object.assign(i,confirmedEmailState(i));const r=next(i);
 assert.equal(r.next_step,'email_recovery_confirm');assert.match(r.email_question,/requires an email/);Object.assign(i,r);
 const candidate=await recoverEmail({...i,call_id:'required-reopt-in',utterance:'v i n c e at c a l l s t r e a m a i dot com'},{});Object.assign(i,candidate,{email_confirmed:true,email_accepted:true});
 assert.equal(i.customer_email,base.customer_email);assert.equal(i.email_declined,false);assert.equal(next(i).next_step,'availability_check');
 assert.equal(next({...i,email_declined:true,email_required_explained:true}).next_step,'account_support');
 for(const k of ['customer_name','caller_phone','vehicle_model','pickup_address'])assert.equal(i[k],base[k]);
});
test('email is required at commit even for text-only confirmations; no browser action occurs',async()=>{
 process.env.VOICE_TEST_BOOKING_ENABLED='true';process.env.VOICE_TEST_PHONE='4102790548';
 for(const patch of [{customer_email:null},{customer_email:'bad@a@.com'},{email_confirmed:false},{email_declined:true}])assert.equal((await bookVoiceTest(null,{...base,...patch})).status,'email_required');
});
test('legacy version retains its contract until the candidate is promoted',()=>{
 assert.deepEqual(pickupCorrectionState({...base,contact_contract_version:undefined,pickup_address:'20020 Highway 99 Lynnwood WA 98036'}),{});
 assert.deepEqual(confirmedEmailState({email_declined:true}),{customer_email:null,email_confirmed:true});
});
test('plain refusal explains required email without a model; later corrections remain available',async()=>{
 for(const utterance of ['Leave it out.','Skip the email.','I do not want an email.','No email.','I cannot provide an email.']){
  const r=await recoverEmail({call_id:'decline-'+utterance,contact_contract_version:2,upfront_intake:true,utterance,previous_email:'old@example.com'},{});
  assert.equal(r.email_required_explained,true);assert.equal(r.customer_email,'none');assert.equal(r.email_resume_node,'policy_hook');assert.match(r.email_question,/requires an email/);
 }
});
