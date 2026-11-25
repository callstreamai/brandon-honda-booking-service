import {inputFingerprint,policyDecision,isServiceDate} from './policy.js';
import {readbackFields} from './schedulerChoices.js';
import {normalizeResponseState} from './responseValues.js';
import {hasServiceConcern} from './serviceMatch.js';
const yes=v=>v===true||v==='true';
export function searchInput(input){
 const out=normalizeResponseState(input);
 if(yes(out.anticipatory_availability)&&!out.preferred_date)out.earliest_requested=true;
 if(yes(out.completion_fallbacks)&&/^\d{4}-\d{2}-\d{2}$/.test(String(out.preferred_date||'')))out.earliest_requested=false;
 return out;
}
export function canPrefetch(input){
 return yes(input.anticipatory_availability)&&input.call_id&&
 !['cancel','reschedule'].includes(input.existing_action)&&
 input.vehicle_mileage!=null&&String(input.vehicle_mileage).trim()!==''&&
 ['vehicle_year','vehicle_make','vehicle_model','vehicle_type'].every(k=>input[k])&&hasServiceConcern(input.service_concern)&&
 ['individual','business'].includes(input.customer_account_type)&&
 ['wait','dropoff','pickup'].includes(input.transport_option)&&
 (isServiceDate(input.preferred_date)||yes(input.earliest_requested))&&
 policyDecision(input).action==='schedule';
}
export const searchKey=i=>JSON.stringify([inputFingerprint(i),i.preferred_date||null,yes(i.earliest_requested),i.preferred_time||null,i.service_recovery_answer||null]);
export function createAvailabilityPrefetch(run,{now=Date.now,ttlMs=90000,capacity=20}={}){
 const jobs=new Map();
 const prune=()=>{for(const [id,j]of jobs)if(j.finished!==null&&now()-j.finished>ttlMs)jobs.delete(id);};
 function start(raw){
  prune();const input=searchInput(raw),id=input.call_id,key=searchKey(input);let prior=jobs.get(id);
  if(prior?.key===key&&(prior.finished===null||now()-prior.finished<=ttlMs))return prior;
  if(!prior&&jobs.size>=capacity)return null;
  const job={key,started:now(),finished:null,result:null,promise:null};
  // Different requests for one caller must never drive the same browser concurrently.
  job.promise=(async()=>{if(prior)await prior.promise;try{job.result=await run('availability',{...input});}catch{job.result={success:false,status:'availability_error'};}job.finished=now();return job.result;})();
  jobs.set(id,job);return job;
 }
 return {
  start(input){if(!canPrefetch(searchInput(input)))return {status:'not_started'};const job=start(input);return {status:job?(job.finished!==null?'ready':'searching'):'capacity'};},
  async consume(input){const prior=jobs.get(input.call_id);const job=start(input);if(!job)return {success:false,status:'capacity'};const t=now();const result=await job.promise;if(jobs.get(input.call_id)!==job)return {success:false,status:'availability_superseded',available_slots:[]};return {...result,...(yes(input.completion_fallbacks)&&result.success&&/^\d{4}-\d{2}-\d{2}$/.test(String(result.preferred_date||''))?readbackFields(input,result.preferred_date):{}),prefetch_used:prior===job,prefetch_wait_ms:now()-t,prefetch_total_ms:job.finished-job.started};},
  async close(id){const job=jobs.get(id);if(job)await job.promise;jobs.delete(id);},
  size(){prune();return jobs.size;}
 };
}
