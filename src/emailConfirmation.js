import {validEmail} from './emailRecovery.js';
const yes=v=>v===true||v==='true';
// One helper-returned candidate is both read aloud and committed on explicit acceptance.
// A second LLM extraction is never the authority for the accepted spelling.
export function confirmedEmailState(input){
 if(yes(input.email_declined))return {customer_email:null,email_confirmed:true};
 if(yes(input.email_accepted)&&yes(input.email_confirmed)&&validEmail(input.email_candidate)&&input.customer_email===input.email_candidate)return {customer_email:input.email_candidate,email_confirmed:true};
 return {};
}
