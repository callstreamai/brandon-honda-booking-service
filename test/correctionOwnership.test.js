import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverPathway} from '../src/pathwayRecovery.js';
import {recoverEmail,spelledEmail} from '../src/emailRecovery.js';
test('late email correction reuses email helper without changing other customer fields',async()=>{
 const state={customer_name:'Isabelle Tess',vehicle_year:'2020',vehicle_model:'Focus',caller_phone:'4102790548',email_declined:true,booking_status:null};
 const before=structuredClone(state);
 const r=await recoverPathway({call_id:'late-email',completion_fallbacks:true,utterance:'I changed my mind about email. Use vince at callstreamai dot com.',state},{});
 assert.equal(r.recovery_resume_node,'email_recovery_helper');assert.equal(r.recovery_status,'resume_email');assert.deepEqual(state,before);
 const e=await recoverEmail({call_id:'late-email',utterance:'vince@callstreamai.com',previous_declined:true,upfront_intake:true},{});
 assert.equal(e.email_declined,false);assert.equal(e.email_confirmed,false);assert.equal(e.email_resume_node,'contact_confirmation');
});
test('email correction cannot bypass an uncertain booking',async()=>{
 const r=await recoverPathway({call_id:'uncertain-email',completion_fallbacks:true,utterance:'Change my email.',state:{booking_status:'booking_outcome_unknown'}},{});
 assert.equal(r.recovery_resume_node,'pathway_recovery_help');
});
test('word followed by its spelling must not silently duplicate the email domain',()=>{
 assert.equal(spelledEmail('No. It is v I n c e at alpha a l p h a Drive d r I v e a I dot com.'),null);
 assert.equal(spelledEmail('v I n c e at a l p h a d r I v e a I dot com.'),'vince@alphadriveai.com');
});
