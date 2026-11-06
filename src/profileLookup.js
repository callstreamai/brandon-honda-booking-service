import {chromium} from 'playwright-core';
import {dealer} from './policy.js';
const cache=new Map();
let busy=false;
export function lookupPhone(value){const p=String(value||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');return /^\d{10}$/.test(p)?p:null;}
export async function lookupProfile(input){
 const phone=lookupPhone(input.lookup_phone),key=String(input.call_id||'');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:dealer.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const base={caller_last4:phone?.slice(-4)||'',dealer_today:today,profile_found:false};
 if(!phone||!key||key.includes('{{'))return {...base,status:'lookup_phone_required'};
 const prior=cache.get(key);if(prior&&prior.phone===phone&&Date.now()-prior.at<300000)return prior.result;
 if(busy||!process.env.BROWSERLESS_API_KEY)return {...base,status:'lookup_unavailable'};
 busy=true;let browser;
 try{
  const region=process.env.BROWSERLESS_REGION||'production-sfo.browserless.io';
  if(!/^[a-z0-9.-]+\.browserless\.io$/.test(region))return {...base,status:'lookup_unavailable'};
  browser=await chromium.connectOverCDP(`wss://${region}/chromium?token=${encodeURIComponent(process.env.BROWSERLESS_API_KEY)}`,{timeout:10000});
  const p=await browser.newPage();p.setDefaultTimeout(10000);
  await p.goto(dealer.scheduler,{waitUntil:'domcontentloaded',timeout:15000});
  await p.getByRole('textbox',{name:'Enter your mobile phone number',exact:true}).fill(phone);
  await p.getByRole('button',{name:'Continue',exact:true}).click();
  // Only the provider's observed explicit no-record response establishes a miss.
  await p.getByText("We couldn't locate your vehicle record.",{exact:false}).waitFor({timeout:10000});
  const result={...base,status:'no_match',lookup_message:'Ford did not return a vehicle record for the calling number. Ask for the caller and vehicle details.'};
  cache.set(key,{phone,at:Date.now(),result});if(cache.size>100)cache.delete(cache.keys().next().value);return result;
 }catch{return {...base,status:'lookup_unverified',lookup_message:'A Ford customer profile was not verified. Collect the caller and vehicle details without claiming a profile match.'};}
 finally{await browser?.close().catch(()=>{});busy=false;}
}
