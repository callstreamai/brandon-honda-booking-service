import test from 'node:test';import assert from 'node:assert/strict';import {parseReceipt,receiptMatches,ingestReceipt} from '../src/receiptIntake.js';
const email={from:'Your Ford Dealer <fsrplus-noreply@ford.com>',subject:'Service reservation confirmed',received_at:'2026-11-05T22:00:00Z',message_id:'fixture-receipt',text:'Pierre Ford of Lynnwood Vince RPA TEST 2021 Ford Explorer 11/6/2026 at 8:00 AM',html:'<a href="https://www.guestxpui.ford.com/my-reservation?enc=fixture">Manage</a>'};const record={created_at:'2026-11-05T21:59:00Z',status:'confirmed',appointment_id:'1234567890',input:{vehicle_year:'2021',vehicle_model:'Explorer',preferred_date:'2026-11-06',preferred_time:'8:00 a.m.'}};
test('receipt intake rejects unknown senders and arbitrary links',()=>{assert.equal(parseReceipt({...email,from:'attacker@example.com'}),null);assert.deepEqual(parseReceipt({...email,html:'<a href="https://example.com/delete">link</a>'}).links,[]);});
test('receipt must match the existing booking vehicle, date, time and creation window',()=>{assert.equal(receiptMatches(record,parseReceipt(email)),true);assert.equal(receiptMatches({...record,input:{...record.input,preferred_date:'2026-11-09'}},parseReceipt(email)),false);assert.equal(receiptMatches({...record,created_at:'2026-11-06T00:00:00Z'},parseReceipt(email)),false);});
test('email cancellation never performs a write or clears an uncertain result',()=>{let patch;const store={all:()=>[record],update:(_,p)=>patch=p};const result=ingestReceipt({...email,subject:'Your reservation has been canceled'},store);assert.equal(result.accepted,true);assert.equal(patch.cancellation_email_received,true);assert.equal(patch.status,undefined);assert.equal(patch.cancel_status,undefined);});

test('Gmail import can corroborate a specifically identified completed reservation',()=>{let patch;const store={all:()=>[{...record,status:'cancelled'}],update:(_,p)=>patch=p};const result=ingestReceipt({...email,subject:'Your reservation has been canceled'},store,'1234567890');assert.equal(result.accepted,true);assert.equal(patch.cancellation_email_received,true);assert.equal(patch.status,undefined);});

test('Ford cancellation email without a time can only corroborate an already cancelled identified record',()=>{const mail={...email,subject:'Your reservation has been canceled',text:email.text.replace(' at 8:00 AM','')};let patch;const store={all:()=>[{...record,status:'cancelled'}],update:(_,p)=>patch=p};assert.equal(ingestReceipt(mail,store,'1234567890').accepted,true);assert.equal(patch.cancellation_email_received,true);assert.equal(ingestReceipt(mail,store).accepted,false);assert.equal(receiptMatches(record,parseReceipt(mail)),false);});
test('unknown submission is linked by its exact call without inventing a reservation ID or confirming a booking',()=>{
 const a={...record,status:'unknown',appointment_id:null,call_id:'exact-call'},b={...a,call_id:'other-call'};let changed,patch;
 const store={all:()=>[a,b],update:(r,p)=>{changed=r;patch=p;}};
 const result=ingestReceipt(email,store,null,'exact-call');assert.equal(result.accepted,true);assert.equal(changed,a);assert.equal(patch.status,undefined);assert.equal(patch.appointment_id,undefined);assert.equal(result.appointment_id,null);
 assert.equal(ingestReceipt({...email,text:email.text.replace('Explorer','Bronco')},store,null,'exact-call').accepted,false);
});
test('legacy truncated fixture marker must match the recorded full test name',()=>{
 const mail={...email,text:email.text.replace('Vince RPA TEST','Isabelle RPA TE Thautilus')};
 const r={...record,input:{...record.input,customer_name:'Isabelle Thautilus'}};
 assert.equal(receiptMatches(r,parseReceipt(mail)),true);
 assert.equal(receiptMatches({...r,input:{...r.input,customer_name:'Isabelle Other'}},parseReceipt(mail)),false);
 assert.equal(parseReceipt({...email,text:email.text.replace('RPA TEST','regular customer')}),null);
});
