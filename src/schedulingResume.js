import {accountTypeFor} from './accountType.js';
import {isServiceDate,normalizeTransport} from './policy.js';
import {validEmail} from './emailRecovery.js';
import {valetMissing} from './valet.js';
import {hasServiceConcern} from './serviceMatch.js';
const yes=v=>v===true||v==='true';
const supplied=v=>v!=null&&!['','none','null','undefined'].includes(String(v).trim().toLowerCase())&&!String(v).includes('{{');

// This replaces conversational ordering for the opt-in candidate. The existing
// policy webhook owns the next question; dialogue nodes only speak its output.
export function schedulingDecision(i,policy){
 const result=(next_step,step_question='',intake_field='')=>({next_step,step_question,intake_field});
 const ask=(field,question)=>result('contact_name',question,field);
 const business=accountTypeFor(i)==='business';
 if(!accountTypeFor(i))return result('account_type');
 if(business&&!supplied(i.business_name))return ask('business_name','What business or fleet name should the appointment be under?');
 if(!business&&!supplied(i.customer_name))return ask('customer_name','May I have your first and last name?');
 if(!business&&String(i.customer_name).trim().split(/\s+/).length<2)return ask('customer_name','And your last name?');
 if(!yes(i.caller_phone_confirmed)||!/^1?\d{10}$/.test(String(i.caller_phone||'').replace(/\D/g,'')))return ask('caller_phone','Is the number you’re calling from the best number for your appointment?');
 const vehicle=['vehicle_year','vehicle_make','vehicle_model'].filter(k=>!supplied(i[k]));
 if(vehicle.length)return ask('vehicle_identity',vehicle.length===3?'What is the year, make, and model of your vehicle?':`What is the ${vehicle.map(k=>k.replace('vehicle_','')).join(' and ')} of your vehicle?`);
 if(Number(i.contact_contract_version)>=2&&(!validEmail(i.customer_email||'')||!yes(i.email_confirmed)||yes(i.email_declined))){
  if(yes(i.email_declined)){
   if(yes(i.email_required_explained))return result('account_support');
   return {...result('email_recovery_confirm'),email_required_explained:true,email_declined:false,email_accepted:false,email_confirmed:false,customer_email:'none',email_candidate:'none',email_helper_status:'clarify',email_resume_node:'policy_hook',email_question:'The scheduler requires an email address to book your appointment. What email address can we use?'};
  }
  return result(business?'business_email':'contact_email');
 }
 if(!yes(i.email_confirmed)||(!validEmail(i.customer_email||'')&&!yes(i.email_declined)))return result(business?'business_email':'contact_email');
 if(business&&!validEmail(i.customer_email||''))return result('account_support');
 if(!['Text','Email','Both','None','Phone'].includes(i.confirmation_method))return result('contact_confirmation');
 if(!supplied(i.vehicle_type))return i.intake_field==='vehicle_type'&&supplied(i.last_user_message)?result('fuel_help'):ask('vehicle_type','Is your vehicle gasoline-only, hybrid, diesel, or fully electric?');
 if(!['Gas','Hybrid','Diesel','Electric'].includes(i.vehicle_type))return result('fuel_help');
 if(!supplied(i.vehicle_mileage))return ask('vehicle_mileage','About how many miles are on that vehicle? It is okay if you don’t know.');
 if(!hasServiceConcern(i.service_concern))return result('service_need','What service or concern would you like us to address?');
 if(policy.action==='handoff'||policy.action==='decline')return result(null);
 if(policy.action==='clarify'&&['bumper_warranty','parts_arrived'].includes(policy.field))return result('policy_clarify',policy.field==='bumper_warranty'?'Is the vehicle covered by the manufacturer’s bumper-to-bumper warranty?':'Has Parts or Service notified you that the part has arrived?');
 const dropOnly=policy.dropOnly||policy.action==='clarify'&&policy.field==='transport_option'&&/requires drop-off/.test(policy.reason||'');
 const pickupEligible=/^(ford|lincoln)$/i.test(i.vehicle_make||'');
 const transport=normalizeTransport(i.transport_option);
 if(!['wait','dropoff','pickup'].includes(transport)||policy.action==='clarify'&&policy.field==='transport_option')return result('transport_option',dropOnly?(pickupEligible?'For this service, would you prefer drop-off or pickup and delivery?':'This service requires drop-off. Would that work for you?'):(pickupEligible?'Would you prefer to wait, drop off, or use pickup and delivery?':'Would you prefer to wait or drop off?'));
 if(transport==='pickup'){
  if(!supplied(i.pickup_address)||!/^\d+\s+.+\b\d{5}(?:-\d{4})?\s*$/.test(i.pickup_address))return result('valet_details','What is the full pickup address, including city, state, and ZIP code?');
  if(!supplied(i.pickup_access))return result('valet_details','Where will the vehicle and keys be for pickup?');
  if(String(i.pickup_access).length>125)return result('valet_details','Could you shorten the vehicle and key instructions to one brief sentence?');
  if(!['yes','no'].includes(i.vehicle_operable))return result('valet_details','Is the vehicle safe and operable for pickup?');
  if(i.vehicle_operable==='no')return result('pathway_recovery_help');
  if(valetMissing(i))return result('prepare_valet_readback');
 }
 if(!isServiceDate(i.preferred_date)&&!yes(i.earliest_requested))return result('date_preference');
 return result('availability_check');
}
export function nextSchedulingStep(input,policy){
 if(yes(input.upfront_intake))return schedulingDecision(input,policy).next_step;
 if(policy.action!=='schedule')return null;
 if(!accountTypeFor(input))return 'account_type';
 if(accountTypeFor(input)==='business'&&!String(input.business_name||'').trim())return 'business_name';
 if(!String(input.customer_name||'').trim())return 'contact_name';
 if(!/^1?\d{10}$/.test(String(input.caller_phone||'').replace(/\D/g,'')))return 'account_phone';
 if(!input.vehicle_year||!input.vehicle_make||!input.vehicle_model||!input.vehicle_type)return 'vehicle_year';
 if([true,'true'].includes(input.anticipatory_availability)){
  if(input.vehicle_mileage==null||String(input.vehicle_mileage).trim()==='')return 'vehicle_mileage';
  if(!String(input.service_concern||'').trim())return 'service_need';
  if(!['wait','dropoff','pickup'].includes(normalizeTransport(input.transport_option)))return 'transport_option';
 }
 if(accountTypeFor(input)==='business'&&!/^\S+@\S+\.\S+$/.test(input.customer_email||''))return 'business_email';
 if(!['Text','Email','Both','None','Phone'].includes(input.confirmation_method))return input.customer_email?'contact_confirmation':'contact_email';
 if(!String(input.service_concern||'').trim())return 'service_need';
 if(!['wait','dropoff','pickup'].includes(normalizeTransport(input.transport_option)))return 'transport_option';
 if(!isServiceDate(input.preferred_date)&&![true,'true'].includes(input.earliest_requested))return 'date_preference';
 return 'availability_check';
}
