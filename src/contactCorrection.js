import {recoverEmail} from './emailRecovery.js';
// Route an explicit email correction from any policy-bound collection turn to
// the existing email owner, preserving the rest of the scheduling request.
export async function contactCorrection(input,env=process.env,fetcher=fetch){
 const text=String(input.last_user_message||'');
 if(!/\b(?:change|correct|update|use|email is|email should)\b/i.test(text)||!(/\bemail\b/i.test(text)&&/@|\bat\b/i.test(text)))return null;
 if(/unknown|pending|booked|confirmed/.test(input.booking_status||''))return null;
 let utterance=text;
 const emails=text.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)||[];
 if(emails.length===1&&!/\b(?:not|don't|do not)\s+(?:use|send|change)\b/i.test(text))utterance=emails[0];
 return recoverEmail({...input,utterance,last_user_message:utterance,previous_email:input.customer_email},env,fetcher);
}
