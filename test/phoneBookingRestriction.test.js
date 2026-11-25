import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bookingStore} from '../src/bookingStore.js';
import {bookVoiceTest} from '../src/voiceBooking.js';

test('an existing appointment on a phone does not block a new call; retries keep the original result', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lynwood-phone-booking-'));
 const previous={...process.env};
 try{
  process.env.BOOKING_STORE_PATH=path.join(dir,'bookings.json');
  process.env.VOICE_TEST_BOOKING_ENABLED='true';
  process.env.VOICE_TEST_PHONES='4102790548';
  const input={call_id:'old-call',caller_phone:'4102790548',customer_name:'Vince Test',customer_email:'vince@example.com',readback_confirmed:true,confirmation_method:'Email',vehicle_year:'2023',vehicle_make:'Ford',vehicle_model:'Maverick',vehicle_type:'Gas',service_concern:'oil change',transport_option:'dropoff',preferred_date:'2026-12-01',preferred_time:'8:00 a.m.'};
  const store=bookingStore(),record=store.reserve(input);
  for(const status of ['confirmed','submitted','unknown']){
   store.update(record,{status,appointment_id:'1234567890'});
   const result=await bookVoiceTest(null,{...input,call_id:'new-call-'+status});
   assert.equal(result.status,'fresh_availability_required');
   assert.equal(store.all().length,1);
  }
  store.update(record,{status:'confirmed'});
  const retry=await bookVoiceTest(null,input);
  assert.equal(retry.status,'booked');
  assert.equal(retry.appointment_id,'1234567890');
  assert.equal(store.all().length,1);
 }finally{
  for(const key of ['BOOKING_STORE_PATH','VOICE_TEST_BOOKING_ENABLED','VOICE_TEST_PHONES']){
   if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  }
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
