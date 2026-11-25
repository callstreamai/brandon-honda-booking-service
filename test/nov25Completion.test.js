import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createServiceCollection} from '../src/serviceCollection.js';
import {schedulingDecision} from '../src/schedulingResume.js';
import {canPrefetch,searchInput} from '../src/availabilityPrefetch.js';
test('service closure survives process recreation without trusting caller-extracted completion',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lynwood-list-')),file=path.join(dir,'state.json');try{
 const input={call_id:'call-a',service_collection_contract:1,service_concern:'oil change and wipers',service_complete:true};
 let collect=createServiceCollection(file);assert.equal(collect(input).service_complete,false);
 assert.equal(collect({...input,intake_field:'service_additions',last_user_message:'No, nothing else.'}).service_complete,true);
 collect=createServiceCollection(file);assert.equal(collect({...input,last_user_message:'December 1 please.'}).service_complete,true);
 assert.equal(collect({...input,call_id:'different-caller'}).service_complete,false);
 assert.equal(collect({...input,service_concern:null}).service_complete,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('confirmation preference is asked while eligible availability can run; email remains upfront',()=>{
 const input={upfront_intake:true,contact_contract_version:2,anticipatory_availability:true,customer_account_type:'individual',call_id:'prefetch-confirm',customer_name:'Vince Test',caller_phone:'4102790548',caller_phone_confirmed:true,vehicle_year:'2022',vehicle_make:'Ford',vehicle_model:'Explorer',vehicle_type:'Gas',vehicle_mileage:'unknown',service_concern:'oil change',service_complete:true,service_collection_contract:1,transport_option:'dropoff',earliest_requested:true};
 assert.equal(schedulingDecision(input,{action:'schedule'}).next_step,'contact_email');
 const collected={...input,customer_email:'vince@example.com',email_confirmed:true};
 assert.equal(schedulingDecision(collected,{action:'schedule'}).next_step,'contact_confirmation');
 assert.equal(Boolean(canPrefetch(searchInput(collected))),true);
 assert.equal(schedulingDecision({...collected,confirmation_method:'Both'},{action:'schedule'}).next_step,'availability_check');
});
import {resolveServices} from '../src/serviceRecovery.js';
test('check-engine uses the observed diagnostic intake with the original concern, not an unrelated maintenance service',async()=>{
 const input={completion_fallbacks:true,service_concern:'The check engine light is on.'},menu=['Oil Change','CHECK ENGINE LAMP IS ON'];
 const r=await resolveServices(input,menu,{},()=>{throw Error('not needed');},{manualConcern:true});assert.equal(r.service_recovery_action,'manual_description');assert.deepEqual(r.service_labels,['General Diagnosis']);assert.equal(input.service_concern,'The check engine light is on.');
 const noManual=await resolveServices(input,menu,{},()=>{throw Error('not needed');},{manualConcern:false});assert.deepEqual(noManual.service_labels,['CHECK ENGINE LAMP IS ON']);
});
