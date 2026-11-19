import test from 'node:test';
import assert from 'node:assert/strict';
import {createAvailabilityPrefetch,canPrefetch,searchInput} from '../src/availabilityPrefetch.js';
import {nextSchedulingStep} from '../src/schedulingResume.js';
const base={anticipatory_availability:true,call_id:'test',customer_account_type:'individual',customer_name:'Vince',caller_phone:'4102790548',vehicle_year:'2025',vehicle_make:'Ford',vehicle_model:'Maverick',vehicle_type:'Gasoline',vehicle_mileage:'12000',service_concern:'oil change',transport_option:'wait'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('search begins without awaiting calendar; email collection reuses exactly one read',async()=>{
 const d=deferred();let calls=0;const p=createAvailabilityPrefetch(async()=>{calls++;return d.promise;});
 assert.equal(p.start(base).status,'searching');assert.equal(calls,1);
 const pending=p.consume({...base,customer_email:'correct@example.com',confirmation_method:'Both'});
 d.resolve({success:true,available_slots:['09:00']});const r=await pending;
 assert.equal(calls,1);assert.equal(r.prefetch_used,true);assert.deepEqual(r.available_slots,['09:00']);
});
test('changed vehicle, service, transport, mileage and date serialize and never return prior times',async()=>{
 for(const change of [{vehicle_model:'Explorer'},{service_concern:'battery'},{transport_option:'dropoff'},{vehicle_mileage:'40000'},{preferred_date:'2026-11-23'}]){
  const first=deferred();let calls=0;const p=createAvailabilityPrefetch(async(_,i)=>{calls++;return calls===1?first.promise:{success:true,available_slots:['new'],model:i.vehicle_model};});
  p.start(base);const old=p.consume(base);p.start({...base,...change});const current=p.consume({...base,...change});assert.equal(calls,1);
  first.resolve({success:true,available_slots:['old']});assert.equal((await old).status,'availability_superseded');assert.deepEqual((await current).available_slots,['new']);assert.equal(calls,2);
 }
});
test('expiry and caller isolation prevent stale or cross-caller reuse',async()=>{
 let clock=0,calls=0;const p=createAvailabilityPrefetch(async()=>({success:true,sequence:++calls}),{now:()=>clock,ttlMs:90});
 await p.consume(base);clock=20;assert.equal((await p.consume(base)).sequence,1);
 assert.equal((await p.consume({...base,call_id:'different'})).sequence,2);
 clock=91;assert.equal((await p.consume(base)).sequence,3);await p.close(base.call_id);assert.equal((await p.consume(base)).sequence,4);
});
test('missing prerequisites, valet address, existing changes and policy handoffs never prefetch',()=>{
 for(const change of [{vehicle_mileage:null},{vehicle_type:null},{transport_option:'pickup'},{service_concern:'recall'},{existing_action:'cancel'},{existing_action:'reschedule'},{anticipatory_availability:false}])assert.equal(Boolean(canPrefetch(searchInput({...base,...change}))),false,JSON.stringify(change));
 assert.equal(Boolean(canPrefetch(searchInput(base))),true);
});
test('earliest default respects explicit date and natural canonical values',()=>{
 assert.equal(searchInput(base).earliest_requested,true);assert.equal(searchInput(base).vehicle_type,'Gas');
 assert.equal(searchInput({...base,preferred_date:'2026-11-23'}).earliest_requested,undefined);
 assert.equal(searchInput({...base,preferred_date:'next Wednesday'}).earliest_requested,undefined);
});
test('capacity and errors are not successful availability or invented empty calendars',async()=>{
 const d=deferred();const p=createAvailabilityPrefetch(async()=>d.promise,{capacity:1});p.start(base);
 assert.equal(p.start({...base,call_id:'second'}).status,'capacity');assert.equal((await p.consume({...base,call_id:'second'})).success,false);d.resolve({success:false,status:'calendar_read_timeout'});assert.equal((await p.consume(base)).status,'calendar_read_timeout');
 const q=createAvailabilityPrefetch(async()=>{throw Error('fail');});assert.equal((await q.consume(base)).status,'availability_error');
});
test('new intake order progresses and preserves existing email preferences',()=>{
 const policy={action:'schedule'};assert.equal(nextSchedulingStep(searchInput({...base,vehicle_mileage:null}),policy),'vehicle_mileage');
 assert.equal(nextSchedulingStep(searchInput({...base,service_concern:null}),policy),'service_need');
 assert.equal(nextSchedulingStep(searchInput({...base,transport_option:null}),policy),'transport_option');
 assert.equal(nextSchedulingStep(searchInput(base),policy),'contact_email');
 assert.equal(nextSchedulingStep(searchInput({...base,customer_email:'test@example.com',confirmation_method:'Both'}),policy),'availability_check');
});

test('specific day wins over earliest-that-day and cached availability uses corrected identity',async()=>{
 const input={...base,completion_fallbacks:true,preferred_date:'2026-11-27',earliest_requested:true};
 assert.equal(searchInput(input).earliest_requested,false);
 let count=0;const p=createAvailabilityPrefetch(async()=>{count++;return {success:true,status:'availability_found',preferred_date:'2026-11-27',available_slots:['9:00 a.m.'],booking_customer_name:'Old Name',contact_readback:'Old phone'};});
 await p.consume(input);const r=await p.consume({...input,customer_name:'Isabel Task',caller_phone:'4102790555'});
 assert.equal(count,1);assert.equal(r.booking_customer_name,'Isabel Task');assert.match(r.contact_readback,/410-279-0555/);assert.deepEqual(r.available_slots,['9:00 a.m.']);
});
