import test from 'node:test';import assert from 'node:assert/strict';
import {recoverEmail,spelledEmail} from '../src/emailRecovery.js';
import {resolveServices} from '../src/serviceRecovery.js';
import {hasServiceConcern} from '../src/serviceMatch.js';
import {completionDefaults} from '../src/responseValues.js';
import {allowedTestCaller} from '../src/bookingStore.js';
import {conversationEnded} from '../src/sessionLifecycle.js';
const noModel=()=>{throw Error('Unexpected model call');};
test('actual email correction retains corrected local part across domain-only reply',async()=>{
 const b={call_id:'nov25-email6',upfront_intake:true,contact_contract_version:2};
 const a=await recoverEmail({...b,utterance:'Use. Bilma at alphadriveai.com.'},{},noModel);assert.equal(a.email_candidate,'bilma@alphadriveai.com');
 const c=await recoverEmail({...b,previous_email:'use.bilma@alphadriveai.com',utterance:"No, it's B I L M A at Alpha Drive."},{},noModel);assert.equal(c.email_candidate,'none');assert.match(c.email_question,/domain/);
 const d=await recoverEmail({...b,previous_email:'use.bilma@alphadriveai.com',utterance:'Alphadriveai.com.'},{},noModel);assert.equal(d.email_candidate,'bilma@alphadriveai.com');assert.equal(d.email_confirmed,false);
});
test('actual punctuation and spoken digits remain recoverable after repeated failed interpretations',async()=>{
 const b={call_id:'nov25-email1',upfront_intake:true};for(let i=0;i<8;i++)await recoverEmail({...b,utterance:'something unclear '+i},{},noModel);
 assert.equal((await recoverEmail({...b,utterance:'B I L M A, I S A B E L nine two. at gmail dot com'},{},noModel)).email_candidate,'bilmaisabel92@gmail.com');
 assert.equal(spelledEmail('bilma at alpha drive ai dot com'),null);
 assert.equal(spelledEmail('B or D at example dot com'),null);
});
test('manual fallback does not replace a fully matched maintenance list or discard an unmatched concern',async()=>{
 const menu=['Oil Change','Tire Rotation','Wipers','CHECK ENGINE LAMP IS ON'];
 for(const concern of ['oil change, tire rotation, and wipers','I have a few things, but I need an oil change tire rotation and wipers',"Wait! I'm not done. I need an oil change tire rotation, and wipers."]){const r=await resolveServices({service_concern:concern},menu,{},noModel,{manualConcern:true});assert.deepEqual(r.service_labels,['Oil Change','Tire Rotation','Wipers']);}
 const mixed=await resolveServices({service_concern:'oil change and transmission slipping'},menu,{},noModel,{manualConcern:true});assert.equal(mixed.service_recovery_action,'manual_description');
 assert.deepEqual((await resolveServices({service_concern:'check engine light'},menu,{},noModel,{manualConcern:true})).service_labels,['CHECK ENGINE LAMP IS ON']);
 for(const concern of ['schedule','schedule an appointment','I want to schedule an appointment','service appointment']){assert.equal(hasServiceConcern(concern),false);assert.equal((await resolveServices({service_concern:concern},menu,{},noModel,{manualConcern:true})).status,'service_clarification_required');}
});
test('fuel answer normalization and wait interruption preserve unrelated details',()=>{
 const b={completion_fallbacks:true,intake_field:'vehicle_type',vehicle_model:'Maverick',customer_email:'bilma@example.com',caller_phone:'2393822414'};
 for(const text of ['gas','gasoline',"It's gas.","I don't know."]){const r=completionDefaults({...b,last_user_message:text});assert.equal(r.vehicle_type,'Gas');assert.equal(r.vehicle_model,b.vehicle_model);assert.equal(r.customer_email,b.customer_email);}
 assert.equal(completionDefaults({...b,last_user_message:'It is diesel.'}).vehicle_type,'Diesel');
 assert.equal(completionDefaults({...b,transport_option:'wait',last_user_message:"Wait! I'm not done. I need wipers too."}).transport_option,null);
});
test('both approved phones, no others, may submit',()=>{const env={VOICE_TEST_BOOKING_ENABLED:'true',VOICE_TEST_PHONES:'4102790548,2393822414'};for(const caller_phone of ['4102790548','+12393822414'])assert.equal(allowedTestCaller({caller_phone},env),true);assert.equal(allowedTestCaller({caller_phone:'2393822415'},env),false);});
test('session cleanup needs verified completed Lynnwood conversation, never active/unknown/other pathway',async()=>{
 const env={BLAND_LIVE_LISTEN_API_KEY:'test'},id='8cb9e8b0-4474-4584-9c2f-fe278cc410f2';
 for(const [data,expected]of [[{pathway_id:'e90854b7-0d4c-418a-81ad-59b1a027c0cc',completed:true},true],[{pathway_id:'e90854b7-0d4c-418a-81ad-59b1a027c0cc',completed:false},false],[{pathway_id:'other',completed:true},false],[{},false]])assert.equal(await conversationEnded(id,env,async()=>({ok:true,status:200,json:async()=>data})),expected);
 assert.equal(await conversationEnded(id,env,async()=>{throw Error('offline');}),false);
});
