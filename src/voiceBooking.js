import {inputFingerprint} from './policy.js';
import {allowedTestCaller,bookingStore,publicRecord,phoneDigits} from './bookingStore.js';
import {prepareTestReview,commitTestBooking,inspectTestBooking} from './testBooking.js';
export function confirmationFromScreen(snapshot){
 const m=String(snapshot.screen_text||'').match(/Your reservation number is:\s*(\d{6,20})\b/i);
 return snapshot.headings?.some(x=>x.trim()==='Thank You!')&&m?m[1]:null;
}
export function reviewMatches(input,selectedServices,screen){
 const plain=String(screen||'').replace(/\s+/g,' ').toLowerCase();
 const date=new Date(input.preferred_date+'T12:00:00Z');if(Number.isNaN(date.getTime()))return false;
 const displayDate=date.toLocaleDateString('en-US',{month:'short',day:'2-digit',year:'numeric',timeZone:'UTC'}).toLowerCase();
 if(!plain.includes(displayDate)||!plain.includes(String(input.preferred_time).toLowerCase()))return false;
 if(!plain.includes(String(input.vehicle_year))||!plain.includes(String(input.vehicle_make).toLowerCase())||!plain.includes(String(input.vehicle_model).toLowerCase())||!plain.includes('pierre ford of lynnwood'))return false;
 if(!selectedServices?.length||!selectedServices.every(x=>plain.includes(x.toLowerCase())))return false;
 if(!plain.replace(/\D/g,'').includes(phoneDigits(input.caller_phone)))return false;
 if(input.customer_email&&input.customer_email!=='none'&&!plain.includes(input.customer_email.toLowerCase()))return false;
 if(input.transport_option==='dropoff'&&!plain.includes("i'll drop the vehicle off"))return false;
 if(input.transport_option==='wait'&&!/i'll wait|i will wait|waiting/.test(plain))return false;
 return true;
}
export async function bookVoiceTest(s,input){
 if(!allowedTestCaller(input))return {success:false,status:'write_disabled'};
 if(![true,'true'].includes(input.readback_confirmed))return {success:false,status:'readback_required'};
 if(!/^\S+\s+\S/.test(input.customer_name||'')||!['Text','Email','Both'].includes(input.confirmation_method))return {success:false,status:'contact_required'};
 if(['Text','Both'].includes(input.confirmation_method)&&![true,'true'].includes(input.sms_consent))return {success:false,status:'communications_consent_required'};
 if(['Email','Both'].includes(input.confirmation_method)&&!/^\S+@\S+\.\S+$/.test(input.customer_email||''))return {success:false,status:'email_required'};
 const store=bookingStore();let record=store.byCall(input.call_id);
 if(record){
  if(inputFingerprint(record.input)!==inputFingerprint(input)||record.input.preferred_date!==input.preferred_date||record.input.preferred_time!==input.preferred_time)return {success:false,status:'existing_booking_changed_request',appointment:publicRecord(record),message:'The existing booking is not this corrected request. Do not create another; verify or cancel the existing record first.'};
  if(record.status==='confirmed')return {success:true,status:'booked',...publicRecord(record)};
  if(record.status==='unknown'&&s?.writeAttempted){const state=await inspectTestBooking(s);const id=confirmationFromScreen(state);if(id){store.update(record,{status:'confirmed',appointment_id:id});return {success:true,status:'booked',...publicRecord(record)};}}
  return {success:false,status:'booking_outcome_unknown',...publicRecord(record)};
 }
 const active=store.active(input.caller_phone);if(active.length)return {success:false,status:'active_test_booking',appointment:publicRecord(active[0]),message:'There is already an outstanding test reservation. Verify or cancel that record before creating another.'};
 if(!s)return {success:false,status:'fresh_availability_required'};
 const review=await prepareTestReview(s,input);
 if(review.status!=='booking_review_ready')return {success:false,status:review.booking_status==='unknown'?'booking_outcome_unknown':'review_incomplete'};
 // The matching calendar session, exact slot selection and visible summary all precede the durable write guard.
 if(!reviewMatches(input,s.selectedServices,review.screen_text))return {success:false,status:'review_mismatch'};
 record=store.reserve(input); // fsync before final Schedule, even if the browser/network subsequently fails.
 const result=await commitTestBooking(s,{...input,review_token:review.review_token});
 const appointmentId=confirmationFromScreen(result);
 await Promise.allSettled(s.receiptReads||[]);
 if(s.receipts?.length)store.update(record,{receipts:s.receipts});
 if(!appointmentId)return {success:false,status:'booking_outcome_unknown',booking_status:'unknown',message:'Do not submit again. This reservation needs verification.'};
 store.update(record,{status:'confirmed',appointment_id:appointmentId});
 return {success:true,status:'booked',...publicRecord(record)};
}
