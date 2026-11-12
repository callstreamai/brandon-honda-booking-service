import {accountTypeFor} from './accountType.js';
import {isServiceDate} from './policy.js';
export function nextSchedulingStep(input,policy){
 if(policy.action!=='schedule')return null;
 if(!accountTypeFor(input))return 'account_type';
 if(accountTypeFor(input)==='business'&&!String(input.business_name||'').trim())return 'business_name';
 if(!['wait','dropoff'].includes(input.transport_option))return 'transport_option';
 if(!isServiceDate(input.preferred_date)&&![true,'true'].includes(input.earliest_requested))return 'date_preference';
 if(!/^1?\d{10}$/.test(String(input.caller_phone||'').replace(/\D/g,'')))return 'account_phone';
 if(accountTypeFor(input)==='business'&&!/^\S+@\S+\.\S+$/.test(input.customer_email||''))return 'business_email';
 if(!['Text','Email','Both','None'].includes(input.confirmation_method))return input.customer_email?'contact_confirmation':'contact_email';
 return 'availability_check';
}
