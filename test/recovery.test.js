import test from 'node:test';
import assert from 'node:assert/strict';
import {recover,recoveryResult} from '../src/recovery.js';
test('vehicle correction clears make, powertrain, slots and approval',()=>{const r=recoveryResult({state:{}},{action:'correct_vehicle',advice:'Use the corrected vehicle.',question:null});assert.equal(r.recovered_state.vehicle_make,'none');assert.equal(r.recovered_state.vehicle_type,'none');assert.deepEqual(r.recovered_state.available_slots,[]);assert.equal(r.recovered_state.readback_confirmed,false);});
test('unknown booking cannot be routed to another submission',()=>{const r=recoveryResult({state:{booking_status:'booking_timeout_unknown'}},{action:'correct_date',advice:'try again',question:'Which day?'});assert.equal(r.recovery_action,'transfer');assert.match(r.recovery_advice,/verify/);});
test('invalid model advice is rejected',()=>assert.throws(()=>recoveryResult({},{action:'book',advice:'book it',question:null})));
test('strict response request excludes call identifier and caches identical requests',async()=>{
 let calls=0;const fetchImpl=async(_url,options)=>{calls++;const p=JSON.parse(options.body);assert.equal(p.store,false);assert.equal(p.text.format.strict,true);assert.equal(JSON.parse(p.input).call_id,undefined);assert.match(p.instructions,/Pierre Ford/);assert.doesNotMatch(p.instructions,/Brandon Honda/);return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'correct_transport',advice:'Honor the correction.',question:null})}]}]})};};
 const env={OPENAI_API_KEY:'test-only',OPENAI_MODEL:'test-only',EXTERNAL_RECOVERY_ENABLED:'true'};
 const b={call_id:'synthetic-recovery-contract',utterance:'I already said I am dropping it off.',state:{transport_option:'wait'}};
 const r=await recover(b,env,fetchImpl);assert.equal(r.recovery_action,'correct_transport');await recover(b,env,fetchImpl);assert.equal(calls,1);
 await recover({...b,utterance:'Second different correction'},env,fetchImpl);
 const last=await recover({...b,utterance:'Third repeated problem'},env,fetchImpl);assert.equal(last.recovery_action,'transfer');assert.equal(calls,2);
});
