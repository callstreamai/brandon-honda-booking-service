import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmedEmailState} from '../src/emailConfirmation.js';
test('confirmed readback retains the exact candidate without changing other details',()=>{
 const b={email_candidate:'vince@alphadriveai.com',customer_email:'vince@alphadriveai.com',email_accepted:true,email_confirmed:true,vehicle_model:'Maverick'};
 assert.deepEqual(confirmedEmailState(b),{customer_email:'vince@alphadriveai.com',email_confirmed:true});assert.equal(b.vehicle_model,'Maverick');
});
test('a newer correction is never overwritten by a previously accepted candidate',()=>assert.deepEqual(confirmedEmailState({email_candidate:'old@example.com',customer_email:'new@example.com',email_accepted:true,email_confirmed:true}),{}));
test('unaccepted, corrected or malformed candidate cannot be committed',()=>{
 for(const b of [{email_accepted:false,email_confirmed:true,email_candidate:'a@example.com'},{email_accepted:true,email_confirmed:false,email_candidate:'a@example.com'},{email_accepted:true,email_confirmed:true,email_candidate:'a@b@.com'}])assert.deepEqual(confirmedEmailState(b),{});
});
test('explicit decline clears old email and does not create messaging consent',()=>assert.deepEqual(confirmedEmailState({email_declined:true,customer_email:'old@example.com'}),{customer_email:null,email_confirmed:true}));
