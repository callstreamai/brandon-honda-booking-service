import test from 'node:test';
import assert from 'node:assert/strict';
import {completionDefaults} from '../src/responseValues.js';
import {schedulingDecision} from '../src/schedulingResume.js';
import {policyDecision} from '../src/policy.js';
import {resolveServices} from '../src/serviceRecovery.js';
import {nearestYears,equivalentModel,appointmentNotes,selectionNote} from '../src/schedulerChoices.js';
const menu=['The Works®','Oil Change','Battery','Brakes','Tire Rotation','Cooling','Filters','Wheel Alignment','Lights','Wipers','Tire Repair/Replace'];
test('explicitly unknown fuel advances fleet intake and preserves contact/vehicle corrections',()=>{
 const state={completion_fallbacks:true,upfront_intake:true,customer_account_type:'business',business_name:'Alpha Test',caller_phone:'4102790548',caller_phone_confirmed:true,caller_id:'+12393822414',vehicle_year:'2023',vehicle_make:'Ford',vehicle_model:'F250',vehicle_type:'unknown',vehicle_mileage:'unknown',customer_email:'vince@callstreamai.com',email_confirmed:true,confirmation_method:'Both',service_concern:'alignment'};
 const out=completionDefaults(state);assert.equal(out.vehicle_type,'Gas');assert.equal(out.fuel_defaulted,true);assert.equal(out.caller_phone,'4102790548');assert.equal(out.customer_email,state.customer_email);assert.equal(out.business_name,state.business_name);assert.equal(out.vehicle_model,'F250');assert.equal(schedulingDecision(out,policyDecision(out)).next_step,'transport_option');
 const corrected=completionDefaults({...out,vehicle_type:'Diesel'});assert.equal(corrected.vehicle_type,'Diesel');assert.equal(corrected.fuel_defaulted,false);assert.equal(corrected.customer_email,state.customer_email);
});
test('default is opt-in and never converts a missing answer or explicit hybrid',()=>{
 assert.equal(completionDefaults({vehicle_type:'unknown'}).vehicle_type,'unknown');
 assert.equal(completionDefaults({completion_fallbacks:true,vehicle_type:null}).vehicle_type,null);
 assert.equal(completionDefaults({completion_fallbacks:true,vehicle_type:'Hybrid'}).vehicle_type,'Hybrid');
 assert.equal(completionDefaults({completion_fallbacks:true,caller_id:'+14102790548'}).caller_phone,'4102790548');
});
test('actual Lincoln work phrases select menu categories without another model question',async()=>{
 let calls=0;const fetcher=()=>{calls++;throw Error('ordinary category selection must not call a model');};
 for(const [concern,expected] of [['I need wipers and an oil change',['Oil Change','Wipers']],['My AC is blowing hot air. And my brakes are also squeaking.',['Brakes']],['I need an oil change, tire rotation, and wipers.',['Oil Change','Tire Rotation','Wipers']]]){
  const input={completion_fallbacks:true,service_concern:concern};const out=await resolveServices(input,menu,{},fetcher);assert.equal(out.status,'services_resolved');assert.deepEqual(out.service_labels,expected);assert.equal(out.service_recovery_question,null);assert.equal(input.service_concern,concern);
 }assert.equal(calls,0);
});
test('closest-service helper uses real menu labels and cannot confirm an appointment',async()=>{
 const input={completion_fallbacks:true,call_id:'closest-engine-test',service_concern:'Check engine light is on.'};
 const fetcher=async(_url,args)=>{const request=JSON.parse(args.body);assert.match(request.instructions,/closest usable/);return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'match',labels:['The Works®'],question:null,reason:'Closest general intake category; diagnostic concern preserved.'})}]}]})};};
 const r=await resolveServices(input,menu,{EXTERNAL_RECOVERY_ENABLED:'true',OPENAI_API_KEY:'test',OPENAI_MODEL:'test'},fetcher);assert.equal(r.status,'services_resolved');assert.deepEqual(r.service_labels,['The Works®']);assert.equal(r.booking_status,undefined);
});
test('same model can use nearest listed year while original vehicle and symptoms remain visible',()=>{
 assert.deepEqual(nearestYears('2020',['Year','2024','2018','2019','2000']),['2019','2018','2024']);
 assert.equal(equivalentModel('F 150',['Escape','F-150','Maverick']),'F-150');assert.equal(equivalentModel('Focus',['Escape','Edge']),null);
 const i={vehicle_year:'2020',vehicle_make:'Ford',vehicle_model:'Focus',service_concern:'I have a check engine light that is on.',fuel_defaulted:true};
 const selected={year:'2018',make:'Ford',model:'Focus',type:'Gas'};
 const notes=appointmentNotes(i,selected,['The Works®']);assert.match(notes,/2020 Ford Focus/);assert.match(notes,/check engine light/);assert.match(selectionNote(i,selected,['The Works®']),/2018 Ford Focus.*2020 Ford Focus/);assert.ok(('RPA TEST; '+notes).length<=125);
});
