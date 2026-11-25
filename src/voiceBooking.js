import {isValet,normalizeAddress} from './valet.js';
import {accountTypeFor} from './accountType.js';
import {validEmail} from './emailRecovery.js';
import {inputFingerprint} from './policy.js';
import {allowedTestCaller,bookingStore,publicRecord,phoneDigits} from './bookingStore.js';
import {prepareTestReview,commitTestBooking,inspectTestBooking} from './testBooking.js';
function spokenDate(i){const date=new Date(i.preferred_date+'T12:00:00Z'),day=date.getUTCDate(),suffix=day>=11&&day<=13?'th':({1:'st',2:'nd',3:'rd'}[day%10]||'th');return date.toLocaleDateString('en-US',{month:'long',timeZone:'UTC'})+' '+day+suffix;}
export function bookingSpeech(i,id){if(!/^\d{6,20}$/.test(String(id)))throw Error('invalid_booking_id');return `Your appointment at Pierre Ford and Lincoln of Lynnwood is confirmed for ${i.service_concern} for your ${i.vehicle_year} ${i.vehicle_make} ${i.vehicle_model}, on ${spokenDate(i)} at ${i.preferred_time} Pacific. Your reservation number is ${id}. Is there anything else I can help you with?`;}
export function submittedSpeech(i){return `I've submitted your appointment at Pierre Ford and Lincoln of Lynnwood for ${spokenDate(i)} at ${i.preferred_time} Pacific. Is there anything else I can help you with?`;}
export function submittedFordError(receipts=[]){return receipts.some(r=>r.origin==='https://api.mss.ford.com'&&r.method==='POST'&&r.path==='/api/guestxpgateway/appointment/schedule'&&r.status===500);}
function submittedResult(record){return {success:true,status:'submitted',...publicRecord(record),appointment_id:null,appointment_confirmed:false,booking_confirmation_speech:submittedSpeech(record.input)};}
export function confirmationFromScreen(snapshot){
 const m=String(snapshot.screen_text||'').match(/Your reservation number is:\s*(\d{6,20})\b/i);
 return snapshot.headings?.some(x=>x.trim()==='Thank You!')&&m?m[1]:null;
}
// Only the original submission's captured provider response is authoritative.
// An HTTP error, an availability response, or a generic duplicate flag cannot
// turn an uncertain write into a confirmed appointment.
export function confirmationFromEvidence(snapshot,receipts=[]){
 const schedule=receipts.filter(r=>r.origin==='https://api.mss.ford.com'&&r.method==='POST'&&r.path==='/api/guestxpgateway/appointment/schedule');
 const ids=new Set(schedule.filter(r=>[200,202].includes(r.status)&&/^\d{6,20}$/.test(String(r.value?.caseId||''))).map(r=>String(r.value.caseId)));
 const screenId=confirmationFromScreen(snapshot||{});if(screenId)ids.add(screenId);
 return ids.size===1?[...ids][0]:null;
}
export function reviewMatches(input,selectedServices,screen){
 const plain=String(screen||'').replace(/\s+/g,' ').toLowerCase();
 const date=new Date(input.preferred_date+'T12:00:00Z');if(Number.isNaN(date.getTime()))return false;
 const displayDate=date.toLocaleDateString('en-US',{month:'short',day:'2-digit',year:'numeric',timeZone:'UTC'}).toLowerCase();
 if(!plain.includes(displayDate)||!plain.includes(String(input.preferred_time).toLowerCase()))return false;
 if(!plain.includes(String(input.vehicle_year))||!plain.includes(String(input.vehicle_make).toLowerCase())||!plain.replace(/[\s-]/g,'').includes(String(input.vehicle_model).toLowerCase().replace(/[\s-]/g,''))||!plain.includes('pierre ford of lynnwood'))return false;
 if(accountTypeFor(input)==='business'&&(!String(input.business_name||'').trim()||!plain.includes(String(input.business_name).trim().replace(/\s+/g,' ').toLowerCase())))return false;
 if(!selectedServices?.length||!selectedServices.every(x=>plain.includes(x.toLowerCase())))return false;
 if(!plain.replace(/\D/g,'').includes(phoneDigits(input.caller_phone)))return false;
 if(input.customer_email&&input.customer_email!=='none'&&!plain.includes(input.customer_email.toLowerCase()))return false;
 if(input.transport_option==='dropoff'&&!plain.includes("i'll drop the vehicle off"))return false;
 if(input.transport_option==='wait'&&!/i'll wait|i will wait|waiting/.test(plain))return false;
 if(isValet(input)&&(!/pickup|pick.up/.test(plain)||!normalizeAddress(plain).includes(normalizeAddress(input.pickup_address))))return false;
 return true;
}
export async function bookVoiceTest(s,input){
 if(!allowedTestCaller(input))return {success:false,status:'write_disabled'};
 if(![true,'true'].includes(input.readback_confirmed))return {success:false,status:'readback_required'};
 if(Number(input.contact_contract_version)>=2&&(!validEmail(input.customer_email)||![true,'true'].includes(input.email_confirmed)||[true,'true'].includes(input.email_declined)))return {success:false,status:'email_required',email_confirmed:false};
 if((accountTypeFor(input)==='business'?!String(input.business_name||'').trim():!/^\S+\s+\S/.test(input.customer_name||''))||!['Text','Email','Both','Phone'].includes(input.confirmation_method))return {success:false,status:'contact_required'};
 if(['Text','Both'].includes(input.confirmation_method)&&![true,'true'].includes(input.sms_consent))return {success:false,status:'communications_consent_required'};
 if(['Email','Both'].includes(input.confirmation_method)&&!/^\S+@\S+\.\S+$/.test(input.customer_email||''))return {success:false,status:'email_required'};
 const store=bookingStore();let record=store.byCall(input.call_id);
 if(record){
  if(inputFingerprint(record.input)!==inputFingerprint(input)||record.input.preferred_date!==input.preferred_date||record.input.preferred_time!==input.preferred_time||phoneDigits(record.input.caller_phone)!==phoneDigits(input.caller_phone)||String(record.input.customer_email||'').trim().toLowerCase()!==String(input.customer_email||'').trim().toLowerCase()||String(record.input.customer_name||'').trim().toLowerCase()!==String(input.customer_name||'').trim().toLowerCase())return {success:false,status:'existing_booking_changed_request',appointment:publicRecord(record),message:'The existing booking is not this corrected request. Do not create another; verify or cancel the existing record first.'};
  if(record.status==='submitted')return submittedResult(record);
  if(record.status==='confirmed')return {success:true,status:'booked',...publicRecord(record),booking_confirmation_speech:bookingSpeech(record.input,record.appointment_id)};
  if(record.status==='unknown'){const id=confirmationFromEvidence(null,record.receipts);if(id){store.update(record,{status:'confirmed',appointment_id:id});return {success:true,status:'booked',...publicRecord(record),booking_confirmation_speech:bookingSpeech(record.input,id)};}}
  if(record.status==='unknown'&&s?.writeAttempted){const state=await inspectTestBooking(s);await Promise.allSettled(s.receiptReads||[]);const id=confirmationFromEvidence(state,s.receipts);if(id){store.update(record,{status:'confirmed',appointment_id:id});return {success:true,status:'booked',...publicRecord(record),booking_confirmation_speech:bookingSpeech(record.input,record.appointment_id)};}}
  if([true,'true'].includes(input.submitted_closing)&&submittedFordError(record.receipts)){store.update(record,{status:'submitted'});return submittedResult(record);}
  return {success:false,status:'booking_outcome_unknown',...publicRecord(record)};
 }
 const active=store.active(input.caller_phone);if(active.length)return {success:false,status:'active_test_booking',appointment:publicRecord(active[0]),message:'There is already an outstanding test reservation. Verify or cancel that record before creating another.'};
 if(!s)return {success:false,status:'fresh_availability_required'};
 if(accountTypeFor(input)!==s.accountType)return {success:false,status:'account_type_mismatch'};
 if(accountTypeFor(input)==='business'&&(!input.business_name||!/^\S+@\S+\.\S+$/.test(input.customer_email||'')))return {success:false,status:'business_details_required'};
 const review=await prepareTestReview(s,input);
 if(review.status!=='booking_review_ready')return {success:false,status:review.booking_status==='unknown'?'booking_outcome_unknown':'review_incomplete'};
 // The matching calendar session, exact slot selection and visible summary all precede the durable write guard.
 const completion=[true,'true'].includes(input.completion_fallbacks);
 const reviewInput=completion&&s.selectedVehicle?{...input,vehicle_make:s.selectedVehicle.make,vehicle_year:s.selectedVehicle.year,vehicle_model:s.selectedVehicle.model,vehicle_type:s.selectedVehicle.type}:input;
 if(!reviewMatches(reviewInput,s.selectedServices,review.screen_text))return {success:false,status:'review_mismatch'};
 if(completion){
   input.scheduler_vehicle=s.selectedVehicle;input.scheduler_services=s.selectedServices;
   input.booking_notes=s.appointmentNotes||input.booking_notes;input.saved_appointment_notes=s.savedAppointmentNotes;
   const actual=[input.vehicle_year,input.vehicle_make,input.vehicle_model].join(' ');
   if(!String(s.savedAppointmentNotes||'').includes(actual))return {success:false,status:'actual_vehicle_notes_required'};
 }
 if(s.manualConcern)input.scheduler_concern=s.verifiedManualConcern;
 record=store.reserve(input); // fsync before final Schedule, even if the browser/network subsequently fails.
 let result;try{result=await commitTestBooking(s,{...input,review_token:review.review_token});}catch{result={};}
 await Promise.allSettled(s.receiptReads||[]);
 const appointmentId=confirmationFromEvidence(result,s.receipts);
 if(s.submissionRequest)store.update(record,{submission_request:s.submissionRequest});
 if(s.receipts?.length)store.update(record,{receipts:s.receipts});
 if(!appointmentId&&[true,'true'].includes(input.submitted_closing)&&submittedFordError(s.receipts)){store.update(record,{status:'submitted'});return submittedResult(record);}
 if(!appointmentId)return {success:false,status:'booking_outcome_unknown',booking_status:'unknown',message:'Do not submit again. This reservation needs verification.'};
 store.update(record,{status:'confirmed',appointment_id:appointmentId});
 return {success:true,status:'booked',...publicRecord(record),booking_confirmation_speech:bookingSpeech(record.input,record.appointment_id)};
}
