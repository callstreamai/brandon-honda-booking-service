import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const phoneDigits=x=>String(x||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
export function allowedTestCaller(input,env=process.env){return env.VOICE_TEST_BOOKING_ENABLED==='true'&&!!env.VOICE_TEST_PHONE&&phoneDigits(input.caller_phone)===phoneDigits(env.VOICE_TEST_PHONE);}
export function createBookingStore(file=process.env.BOOKING_STORE_PATH){
 if(!file)throw new Error('durable_store_required');
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 let data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{records:[]};
 if(!Array.isArray(data.records))throw new Error('invalid_booking_store');
 const persist=()=>{const temp=file+'.tmp';const fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}};
 return {
  all:()=>data.records,
  byCall:id=>data.records.find(r=>r.call_id===id),
  byId:id=>data.records.find(r=>r.appointment_id===String(id)),
  active:phone=>data.records.filter(r=>r.phone===phoneDigits(phone)&&!['cancelled','not_submitted'].includes(r.status)),
  reserve(input){const prior=this.byCall(input.call_id);if(prior)return prior;const r={key:crypto.randomUUID(),call_id:input.call_id,phone:phoneDigits(input.caller_phone),status:'unknown',created_at:new Date().toISOString(),input:{...input}};delete r.input.otp;data.records.push(r);persist();return r;},
  update(record,patch){Object.assign(record,patch,{updated_at:new Date().toISOString()});persist();return record;}
 };
}
let cached;export function bookingStore(){return cached??=createBookingStore();}
export function publicRecord(r){return {appointment_id:r.appointment_id||null,booking_status:r.status,vehicle:[r.input.vehicle_year,r.input.vehicle_make,r.input.vehicle_model,r.input.vehicle_type].join(' '),service:r.input.service_concern,date:r.input.preferred_date,time:r.input.preferred_time,transport:r.input.transport_option,timezone:'America/Los_Angeles'};}
