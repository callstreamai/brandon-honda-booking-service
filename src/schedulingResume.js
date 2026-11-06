import {isServiceDate} from './policy.js';
export function nextSchedulingStep(input,policy){
 if(policy.action!=='schedule')return null;
 if(!['wait','dropoff'].includes(input.transport_option))return 'transport_option';
 if(!isServiceDate(input.preferred_date)&&![true,'true'].includes(input.earliest_requested))return 'date_preference';
 if(!/^1?\d{10}$/.test(String(input.caller_phone||'').replace(/\D/g,'')))return 'account_phone';
 if(!['Text','Email','Both','None'].includes(input.confirmation_method))return input.customer_email?'contact_confirmation':'contact_email';
 return 'availability_check';
}
