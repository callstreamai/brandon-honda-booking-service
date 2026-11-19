import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeResponseState,canonicalValue} from '../src/responseValues.js';
import {recoverPathway} from '../src/pathwayRecovery.js';
import {recover} from '../src/recovery.js';
test('bare yes to a fuel list cannot confirm a hallucinated extracted Hybrid',async()=>{
 const b={call_id:'bare-yes-list',scope:'vehicle_type',utterance:'Yes.',last_question:'Is it gas or hybrid?',state:{vehicle_type:'Hybrid',vehicle_model:'Maverick'}};
 const r=await recover(b,{},()=>{throw Error('model not required');});assert.equal(r.recovery_action,'clarify');assert.equal(r.recovered_state.vehicle_type,null);assert.equal(r.recovered_state.vehicle_model,'Maverick');
 assert.equal((await recover(b,{})).recovery_action,'transfer');
});
test('actual failed call gasoline and natural category variants normalize without erasing details',()=>{
 const s={vehicle_type:'Gasoline',customer_account_type:'Personal',transport_option:'leave it with you',confirmation_method:'both',customer_name:'Vince',customer_email:'vince@alphadriveai.com',vehicle_model:'Maverick',sms_consent:false};
 const r=normalizeResponseState(s);assert.equal(r.vehicle_type,'Gas');assert.equal(r.transport_option,'dropoff');assert.equal(r.confirmation_method,'Both');assert.equal(r.customer_account_type,'individual');assert.equal(r.customer_email,s.customer_email);assert.equal(r.sms_consent,false);assert.equal(s.vehicle_type,'Gasoline');
 for(const phrase of ['yes','guess','gas or hybrid','not gasoline','I think'])assert.equal(canonicalValue('vehicle_type',phrase),null);
});
test('actual adapter complaint reuses explicit gasoline and resumes policy without another fuel question',async()=>{
 const r=await recoverPathway({call_id:'actual-gas-regression',source_node:'adapter_issue',utterance:"It's a gas. But I definitely told you that before a couple times.",state:{vehicle_type:'Gasoline',vehicle_year:'2025',vehicle_make:'Ford',vehicle_model:'Maverick',customer_name:'Vince',service_concern:'oil change',transport_option:'wait'}},{},()=>{throw Error('no model needed');});
 assert.equal(r.recovery_resume_node,'policy_hook');assert.equal(r.recovery_values.vehicle_type,'Gas');assert.equal(r.recovery_question,null);
});
test('fuel helper uses prior explicit answer despite later frustration',async()=>{
 const r=await recover({call_id:'actual-fuel-regression',scope:'vehicle_type',utterance:'We talked about it. I said yes already.',state:{vehicle_type:'Gasoline',vehicle_make:'Ford',vehicle_model:'Maverick'}},{},()=>{throw Error('no model needed');});
 assert.equal(r.recovery_action,'resolved');assert.equal(r.recovered_state.vehicle_type,'Gas');assert.equal(r.recovered_state.vehicle_model,'Maverick');
});
test('OpenAI interpretation must cite caller evidence and cannot write permission',async()=>{
 const b={call_id:'natural-wait',source_node:'transport_option',utterance:'I plan to hang around the lounge until it is done.',state:{customer_name:'Vince',vehicle_model:'Maverick',sms_consent:false,readback_confirmed:false}};
 const env={EXTERNAL_RECOVERY_ENABLED:'true',OPENAI_API_KEY:'fake',OPENAI_MODEL:'fake'};
 const mock=async()=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({resume_node:'policy_hook',advice:'Caller will wait.',question:null,interpretations:[{field:'transport_option',value:'wait',evidence:'hang around the lounge until it is done'}]})}]}]})});
 const r=await recoverPathway(b,env,mock);assert.equal(r.recovery_values.transport_option,'wait');assert.equal(r.recovery_values.customer_name,'Vince');assert.equal(r.readback_confirmed,undefined);assert.equal(b.state.readback_confirmed,false);
});
test('unquoted interpretation and permission injection are rejected',async()=>{
 for(const [i,item]of [{field:'vehicle_type',value:'Gas',evidence:'gasoline'}, {field:'readback_confirmed',value:'true',evidence:'yes please'}].entries()){
  const mock=async()=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({resume_node:'policy_hook',advice:'Continue.',question:null,interpretations:[item]})}]}]})});
  const r=await recoverPathway({call_id:'reject-interpretation-'+i,source_node:'fuel_type',utterance:'yes please',state:{readback_confirmed:false}}, {EXTERNAL_RECOVERY_ENABLED:'true',OPENAI_API_KEY:'fake',OPENAI_MODEL:'fake'},mock);
  assert.equal(r.recovery_status,'help_offered');assert.equal(r.readback_confirmed,undefined);assert.equal(r.recovery_values.vehicle_type,null);
 }
});
