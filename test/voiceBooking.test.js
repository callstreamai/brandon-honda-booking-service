import test from 'node:test';import assert from 'node:assert/strict';import {confirmationFromScreen,confirmationFromEvidence,submittedFordError,submittedSpeech,reviewMatches} from '../src/voiceBooking.js';
test('only the actual Ford success page and literal reservation identifier establish booking',()=>{assert.equal(confirmationFromScreen({headings:['Thank You!'],screen_text:'Your reservation number is: 1234567890'}),'1234567890');assert.equal(confirmationFromScreen({headings:['Reservation Summary'],screen_text:'Your reservation number is: 1234567890'}),null);assert.equal(confirmationFromScreen({headings:['Thank You!'],screen_text:'Something went wrong'}),null);});

test('a stale or changed Ford review cannot pass the final booking check',()=>{const input={preferred_date:'2026-11-06',preferred_time:'8:00 a.m.',vehicle_year:'2021',vehicle_make:'Ford',vehicle_model:'Explorer',caller_phone:'2025550101',customer_email:'casey@example.com',transport_option:'dropoff'};const screen="Pierre Ford of Lynnwood 2021 FORD EXPLORER Battery Nov 06, 2026, 8:00 a.m. PST I'll drop the vehicle off 202-555-0101 casey@example.com";assert.equal(reviewMatches(input,['Battery'],screen),true);assert.equal(reviewMatches({...input,preferred_date:'2026-11-09'},['Battery'],screen),false);assert.equal(reviewMatches({...input,transport_option:'wait'},['Battery'],screen),false);assert.equal(reviewMatches(input,['Oil Change'],screen),false);});

const receipt=(patch={})=>({origin:'https://api.mss.ford.com',method:'POST',path:'/api/guestxpgateway/appointment/schedule',status:200,value:{caseId:'6970839793',hashKey:null,attachmentsUploaded:false},...patch});
test('a successful original Ford submission survives a missing confirmation page',()=>{
 for(const status of [200,202])assert.equal(confirmationFromEvidence({headings:['Reservation Summary'],screen_text:'Temporary issue'},[receipt({status})]),'6970839793');
 const persisted=JSON.parse(JSON.stringify([receipt()]));assert.equal(confirmationFromEvidence(null,persisted),'6970839793');
});
test('a Ford error or unrelated response cannot falsely confirm an uncertain write',()=>{
 for(const bad of [{status:500},{status:202,value:{}},{origin:'https://example.com'},{method:'GET'},{path:'/api/guestxpgateway/appointment/reservations/phone'},{value:{hasDuplicateAppointment:true}},{value:{caseId:'not-a-reservation'}}])assert.equal(confirmationFromEvidence(null,[receipt(bad)]),null);
});
test('conflicting reservation identifiers remain uncertain rather than hiding a duplicate',()=>{
 assert.equal(confirmationFromEvidence(null,[receipt(),receipt({value:{caseId:'1234567890'}})]),null);
 assert.equal(confirmationFromEvidence({headings:['Thank You!'],screen_text:'Your reservation number is: 1234567890'},[receipt()]),null);
 assert.equal(confirmationFromEvidence(null,[receipt(),receipt()]),'6970839793');
});

test('recovery after a browser/process loss reads the saved submission without creating another booking',async()=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const {createBookingStore,bookingStore}=await import('../src/bookingStore.js');const {bookVoiceTest}=await import('../src/voiceBooking.js');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ford-reconcile-'));const file=path.join(dir,'records.json');
 const previous={...process.env};
 try{
  process.env.BOOKING_STORE_PATH=file;process.env.VOICE_TEST_BOOKING_ENABLED='true';process.env.VOICE_TEST_PHONES='2393822414,4102790548';
  const input={call_id:'receipt-recovery',submitted_closing:true,caller_phone:'2393822414',customer_name:'Isabel Test',customer_email:'casey@example.com',readback_confirmed:true,confirmation_method:'Both',sms_consent:true,vehicle_year:'2021',vehicle_make:'Ford',vehicle_model:'Bronco',vehicle_type:'Gas',service_concern:'oil change',preferred_date:'2026-12-01',preferred_time:'8:00 a.m.'};
  const initial=createBookingStore(file);initial.update(initial.reserve(input),{receipts:[receipt()]});
  const uncertain={...input,call_id:'actual-500'};initial.update(initial.reserve(uncertain),{receipts:[receipt({status:500,value:{message:'Internal Server Error'}})]});
  const recovered=await bookVoiceTest(null,input);assert.equal(recovered.status,'booked');assert.equal(recovered.appointment_id,'6970839793');
  for(const changed of [{caller_phone:'4102790548'},{customer_email:'corrected@example.com'},{customer_name:'Another Test'}])assert.equal((await bookVoiceTest(null,{...input,...changed})).status,'existing_booking_changed_request');
  const repeated=await bookVoiceTest(null,input);assert.equal(repeated.appointment_id,'6970839793');
  assert.equal((await bookVoiceTest(null,{...uncertain,submitted_closing:false})).status,'booking_outcome_unknown');
  const unknown=await bookVoiceTest(null,uncertain);assert.equal(unknown.status,'submitted');assert.equal(unknown.appointment_id,null);assert.equal(unknown.appointment_confirmed,false);assert.match(unknown.booking_confirmation_speech,/I've submitted/);assert.doesNotMatch(unknown.booking_confirmation_speech,/verify|transfer|booked|confirmed|reservation number/i);
  assert.equal((await bookVoiceTest(null,uncertain)).status,'submitted');assert.equal(bookingStore().active('2393822414').length,2);
  assert.equal(bookingStore().all().length,2);assert.equal(createBookingStore(file).byCall(input.call_id).status,'confirmed');
 }finally{for(const k of ['BOOKING_STORE_PATH','VOICE_TEST_BOOKING_ENABLED','VOICE_TEST_PHONES']){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}fs.rmSync(dir,{recursive:true,force:true});}
});

test('only a captured final Ford submission error uses the submitted closing',()=>{
 assert.equal(submittedFordError([receipt({status:500})]),true);
 for(const patch of [{status:400},{status:422},{status:503},{status:500,path:'/api/guestxpgateway/customer/lookup'},{status:500,method:'GET'},{status:500,origin:'https://example.com'}])assert.equal(submittedFordError([receipt(patch)]),false);
 assert.equal(submittedFordError([]),false);
 assert.match(submittedSpeech({preferred_date:'2026-12-01',preferred_time:'8:00 a.m.'}),/December 1st.*Pacific.*anything else/);
});
