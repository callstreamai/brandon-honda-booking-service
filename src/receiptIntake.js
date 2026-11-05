import {Resend} from 'resend';
import {bookingStore} from './bookingStore.js';
import {validManagementUrl} from './cancellation.js';
const senders=new Set(['fsrplus-noreply@ford.com','noreply@dealer.reyrey.net']);
const senderAddress=s=>String(s||'').match(/<([^>]+)>/)?.[1]?.toLowerCase()||String(s||'').trim().toLowerCase();
const decode=s=>s.replace(/&amp;/gi,'&').replace(/&nbsp;/gi,' ').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
export function parseReceipt(email){
 if(!senders.has(senderAddress(email.from)))return null;
 const html=String(email.html||'');const plain=decode(String(email.text||'')+' '+html.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').toLowerCase();
 if(!plain.includes('pierre ford of lynnwood')||!plain.includes('rpa test'))return null;
 const links=[];for(const match of html.matchAll(/href=["']([^"']+)["']/gi)){
  let value=decode(match[1]);try{const u=new URL(value);if(u.hostname==='mailer.reyrey.net'&&u.pathname==='/Click.ashx')value=u.searchParams.get('url')||'';}catch{continue;}
  if(validManagementUrl(value))links.push(value);
 }
 return {plain,links:[...new Set(links)],cancelled:/cancel(?:led|ed|lation)/i.test(email.subject||''),received_at:email.received_at||email.created_at||null,message_id:email.message_id||email.id};
}
export function receiptMatches(record,receipt){
 const i=record.input;const plain=receipt.plain;
 const received=Date.parse(receipt.received_at||'');if(!Number.isFinite(received)||received<Date.parse(record.created_at)-60000)return false;
 if(!plain.includes(String(i.vehicle_year))||!plain.replace(/[^a-z0-9]/g,'').includes(String(i.vehicle_model).toLowerCase().replace(/[^a-z0-9]/g,'')))return false;
 const [year,month,day]=i.preferred_date.split('-').map(Number);const dates=[`${month}/${day}/${year}`,`${String(month).padStart(2,'0')}/${String(day).padStart(2,'0')}/${String(year).slice(2)}`,`${String(month).padStart(2,'0')}/${String(day).padStart(2,'0')}/${year}`];
 if(!dates.some(d=>plain.includes(d)))return false;
 const compact=x=>String(x).toLowerCase().replace(/[\s.]/g,'');if(!compact(plain).includes(compact(i.preferred_time)))return false;
 return true;
}
export function ingestReceipt(email,store=bookingStore()){
 const receipt=parseReceipt(email);if(!receipt)return {accepted:false,reason:'receipt_not_allowed'};
 const candidates=store.all().filter(r=>r.status!=='cancelled'&&receiptMatches(r,receipt));
 if(candidates.length!==1)return {accepted:false,reason:'receipt_not_uniquely_matched'};
 const record=candidates[0];if((record.receipt_message_ids||[]).includes(receipt.message_id))return {accepted:true,duplicate:true};
 const patch={receipt_message_ids:[...(record.receipt_message_ids||[]),receipt.message_id].slice(-30),last_receipt_at:receipt.received_at};
 // Cancellation mail corroborates an outcome. It never initiates a cancellation or clears an uncertain write by itself.
 if(receipt.cancelled)patch.cancellation_email_received=true;
 else if(receipt.links.length){patch.management_url=receipt.links.find(x=>new URL(x).hostname==='r7604913.m.reyrey.net')||receipt.links[0];patch.receipt_link_source='signed_receipt_intake';}
 store.update(record,patch);return {accepted:true,appointment_id:record.appointment_id,linked:!!patch.management_url,cancellation_receipt:!!patch.cancellation_email_received};
}
const seen=new Set();let minute=0,count=0;
export async function receiveReceipt(raw,headers,env=process.env){
 if(!env.RESEND_RECEIPT_KEY||!env.RESEND_RECEIPT_WEBHOOK_SECRET||!env.RESEND_RECEIPT_INBOX_ID)throw new Error('receipt_intake_not_configured');
 const client=new Resend(env.RESEND_RECEIPT_KEY);const event=client.webhooks.verify({payload:raw,headers:{id:headers['svix-id'],timestamp:headers['svix-timestamp'],signature:headers['svix-signature']},webhookSecret:env.RESEND_RECEIPT_WEBHOOK_SECRET});
 if(event.type!=='inbox.email.received'||event.data.inbox_id!==env.RESEND_RECEIPT_INBOX_ID)return {accepted:false,reason:'different_inbox_or_event'};
 const bucket=Math.floor(Date.now()/60000);if(bucket!==minute){minute=bucket;count=0;}if(++count>30)throw new Error('receipt_rate_limit');
 const id=headers['svix-id'];if(seen.has(id))return {accepted:true,duplicate:true};
 const {data,error}=await client.inboxes.threads.emails.get({inboxId:env.RESEND_RECEIPT_INBOX_ID,threadId:event.data.thread_id,emailId:event.data.email_id});
 if(error||!data)throw new Error('receipt_fetch_failed');
 const result=ingestReceipt(data);seen.add(id);if(seen.size>1000)seen.delete(seen.values().next().value);return result;
}
