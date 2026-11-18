import {accountTypeFor} from './accountType.js';
import {isServiceDate,normalizeTransport} from './policy.js';
export function nextSchedulingStep(input,policy){
 if(policy.action!=='schedule')return null;
 if(!accountTypeFor(input))return 'account_type';
 if(accountTypeFor(input)==='business'&&!String(input.business_name||'').trim())return 'business_name';
 if(!String(input.customer_name||'').trim())return 'contact_name';
 if(!/^1?\d{10}$/.test(String(input.caller_phone||'').replace(/\D/g,'')))return 'account_phone';
 if(!input.vehicle_year||!input.vehicle_make||!input.vehicle_model||!input.vehicle_type)return 'vehicle_year';
 if(accountTypeFor(input)==='business'&&!/^\S+@\S+\.\S+$/.test(input.customer_email||''))return 'business_email';
 if(!['Text','Email','Both','None','Phone'].includes(input.confirmation_method))return input.customer_email?'contact_confirmation':'contact_email';
 if(!String(input.service_concern||'').trim())return 'service_need';
 if(!['wait','dropoff','pickup'].includes(normalizeTransport(input.transport_option)))return 'transport_option';
 if(!isServiceDate(input.preferred_date)&&![true,'true'].includes(input.earliest_requested))return 'date_preference';
 return 'availability_check';
}
