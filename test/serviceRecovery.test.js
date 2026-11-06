import test from 'node:test';import assert from 'node:assert/strict';
import {resolveServices,validateServiceAdvice} from '../src/serviceRecovery.js';
import {nextSchedulingStep} from '../src/schedulingResume.js';
const menu=['The Works®','Oil Change','Battery','Wheel Alignment'];
const env={OPENAI_API_KEY:'synthetic',OPENAI_MODEL:'synthetic',EXTERNAL_RECOVERY_ENABLED:'true'};
const response=result=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]})});
test('ordinary exact named maintenance bypasses external recovery',async()=>{
 for(const service_concern of ['battery replacement','Oil service, The Works package']){const r=await resolveServices({call_id:'synthetic-service-local',service_concern},menu,env,async()=>{throw new Error('must not call model');});assert.equal(r.status,'services_resolved');assert.equal(r.service_recovery_used,false);}
});
test('an unresolved symptom invokes OpenAI with actual menu and no contact data, then cannot become an alignment',async()=>{
 let calls=0;const input={call_id:'synthetic-service-symptom',customer_name:'Private Name',customer_email:'private@example.com',caller_phone:'2025550101',service_concern:'Steering wheel shakes over 80 mph; oil change package',transport_option:'wait',earliest_requested:true};
 const fetchImpl=async(url,options)=>{calls++;const p=JSON.parse(options.body);assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(p.text.format.strict,true);assert.equal(p.store,false);assert.deepEqual(JSON.parse(p.input).actual_menu,menu);for(const value of ['Private Name','private@example.com','2025550101','synthetic-service-symptom'])assert.ok(!p.input.includes(value));return response({action:'match',labels:['Wheel Alignment','Oil Change'],question:null,reason:'Incorrect inferred repair'});};
 const r=await resolveServices(input,menu,env,fetchImpl);assert.equal(r.status,'service_staff_required');assert.equal(r.service_recovery_used,true);assert.equal(input.transport_option,'wait');assert.equal(input.earliest_requested,true);await resolveServices(input,menu,env,fetchImpl);assert.equal(calls,1);
});
test('one ordinary clarification can resolve a real menu package and preserves unrelated fields',async()=>{
 const input={call_id:'synthetic-service-package',service_concern:'oil change package',transport_option:'wait'};let calls=0;
 const fetchImpl=async()=>response(++calls===1?{action:'clarify',labels:[],question:'Would you prefer a plain oil change or The Works package?',reason:'Package preference needed'}:{action:'match',labels:['The Works®'],question:null,reason:'Caller chose the actual package'});
 assert.equal((await resolveServices(input,menu,env,fetchImpl)).status,'service_clarification_required');const resolved=await resolveServices({...input,service_recovery_answer:'The Works package please.'},menu,env,fetchImpl);assert.deepEqual(resolved.service_labels,['The Works®']);assert.equal(input.transport_option,'wait');
 assert.equal((await resolveServices({...input,service_recovery_answer:'A third different unclear answer'},menu,env,fetchImpl)).status,'service_staff_required');assert.equal(calls,2);
});
test('invented services and diagnosis questions are rejected; unavailable recovery has a bounded staff fallback',async()=>{
 assert.throws(()=>validateServiceAdvice({service_concern:'oil package'},menu,{action:'match',labels:['Diagnosis'],question:null,reason:'invented'}));
 assert.throws(()=>validateServiceAdvice({service_concern:'oil package'},menu,{action:'clarify',labels:[],question:'Would that match Wheel Alignment?',reason:'diagnose'}));
 const r=await resolveServices({call_id:'synthetic-service-timeout',service_concern:'oil package'},menu,env,async()=>{throw new Error('timeout');});assert.equal(r.status,'service_staff_required');
});
test('service recovery resumes at the first missing scheduling step rather than repeating wait or contacts',()=>{
 const input={transport_option:'wait',earliest_requested:true,caller_phone:'2025550101',customer_email:'casey@example.com',confirmation_method:'Both'};
 assert.equal(nextSchedulingStep(input,{action:'schedule'}),'availability_check');assert.equal(nextSchedulingStep({...input,earliest_requested:false},{action:'schedule'}),'date_preference');assert.equal(nextSchedulingStep({...input,transport_option:null},{action:'schedule'}),'transport_option');assert.equal(nextSchedulingStep(input,{action:'clarify'}),null);assert.equal(nextSchedulingStep(input,{action:'handoff'}),null);
});

test('an inconclusive answer cannot cause a second clarification question',async()=>{
 const input={call_id:'synthetic-service-one-question',service_concern:'oil package'};let count=0;const fetchImpl=async()=>{count++;return response({action:'clarify',labels:[],question:'Would you prefer a plain oil change or The Works package?',reason:'Preference unclear'});};
 assert.equal((await resolveServices(input,menu,env,fetchImpl)).status,'service_clarification_required');assert.equal((await resolveServices({...input,service_recovery_answer:'I do not know.'},menu,env,fetchImpl)).status,'service_staff_required');assert.equal(count,2);
});
