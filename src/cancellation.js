import {chromium} from 'playwright-core';
import {allowedTestCaller,bookingStore,phoneDigits,publicRecord} from './bookingStore.js';
import {watchReadRequests} from './readiness.js';
const sessions=new Map();
export function validManagementUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&((u.hostname==='www.guestxpui.ford.com'&&u.pathname==='/my-reservation'&&!!u.searchParams.get('enc'))||(u.hostname==='r7604913.m.reyrey.net'&&u.pathname==='/service-portal/'&&/^[a-f0-9]{32}$/i.test(u.searchParams.get('token')||'')));}catch{return false;}}
export function registerManagementLink(input){if(!allowedTestCaller(input)||!validManagementUrl(input.management_url))return {success:false,status:'invalid_management_link'};const store=bookingStore(),r=store.byId(input.appointment_id);if(!r||r.phone!==phoneDigits(input.caller_phone))return {success:false,status:'appointment_not_found'};store.update(r,{management_url:input.management_url});return {success:true,status:'management_link_saved'};}
async function snapshot(s,input){const result={success:false,status:s.stage,screen_text:(await s.page.locator('body').innerText()).slice(0,16000),headings:await s.page.locator('h1,h2,h3,h4').allTextContents()};if(input.include_screenshot)result.screenshot_base64=(await s.page.screenshot({fullPage:true})).toString('base64');return result;}
setInterval(()=>{for(const[key,s]of sessions)if(!s.busy&&Date.now()-s.touched>600000){sessions.delete(key);void s.browser.close().catch(()=>{});}},60000).unref();
export async function cancelOperation(operation,input){
 if(!allowedTestCaller(input))return {success:false,status:'test_phone_required'};
 const store=bookingStore(),r=store.byId(input.appointment_id);
 if(!r||r.phone!==phoneDigits(input.caller_phone))return {success:false,status:'appointment_not_found'};
 if(r.status==='cancelled')return {success:true,status:'cancelled',...publicRecord(r)};
 if(operation==='state'){const s=sessions.get(input.call_id);return s?await snapshot(s,input):{success:false,status:'cancel_session_missing'};}
 if(r.cancel_status==='unknown')return {success:false,status:'cancellation_outcome_unknown',message:'Do not retry. Verify the existing reservation.'};
 if(!r.management_url)return {success:false,status:'management_link_required',message:'The reservation-management link from the confirmation is needed; do not claim cancellation.'};
 let s=sessions.get(input.call_id);if(s?.busy)return {success:false,status:'session_busy'};
 if(!s){if(operation==='commit')return {success:false,status:'cancel_review_required'};if(sessions.size>=2)return {success:false,status:'capacity'};const region=process.env.BROWSERLESS_REGION||'production-sfo.browserless.io';const browser=await chromium.connectOverCDP(`wss://${region}/chromium?token=${encodeURIComponent(process.env.BROWSERLESS_API_KEY)}&timeout=900000`);const context=await browser.newContext({timezoneId:'America/Los_Angeles',viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(12000);s={browser,page,wait:watchReadRequests(page),stage:'opening',touched:Date.now(),busy:false,appointment_id:r.appointment_id};sessions.set(input.call_id,s);await page.goto(r.management_url,{waitUntil:'domcontentloaded',timeout:30000});}
 if(s.appointment_id!==r.appointment_id)return {success:false,status:'appointment_mismatch'};
 s.busy=true;s.touched=Date.now();
 try{
  const p=s.page;await s.wait();
  if(operation==='commit'){
   if(s.stage!=='cancel_review'||![true,'true'].includes(input.cancel_confirmed))return {success:false,status:'cancel_confirmation_required'};
   const scope=s.reyModal?p.locator('[role="dialog"]').filter({hasText:'Are you sure you want to cancel your appointment?'}):p;
   const final=scope.getByRole('button',{name:s.finalButton,exact:true});if(await final.count()!==1||!await final.isEnabled())return {success:false,status:'cancel_review_changed'};
   store.update(r,{cancel_status:'unknown'});s.stage='cancel_result';
   try{await final.click();await s.wait();}catch{}
   const view=await snapshot(s,input);
   if(/Your reservation has been canceled\./i.test(view.screen_text)&&view.screen_text.includes(r.appointment_id)){store.update(r,{status:'cancelled',cancel_status:'cancelled'});return {success:true,status:'cancelled',...publicRecord(r)};}
   // Other success wording must be mapped from observed outcome, never guessed.
   return {...view,status:'cancellation_outcome_unknown'};
  }
  const otp=p.getByRole('textbox',{name:'One-Time Passcode',exact:true});
  if(await otp.count()){
   if(!/^\d{8}$/.test(input.otp||'')){s.stage='otp_required';return {success:false,status:'otp_required'};}
   if((s.otpAttempts||0)>=2)return {success:false,status:'otp_attempt_limit'};s.otpAttempts=(s.otpAttempts||0)+1;
   await otp.fill(input.otp);await p.getByRole('button',{name:'Continue',exact:true}).click();await s.wait();
   if(await otp.count()){s.stage='otp_required';return {success:false,status:'otp_required'};}
  }
  const body=(await p.locator('body').innerText()).replace(/\s+/g,' ').toLowerCase();
  if(/your reservation has been canceled/.test(body)&&body.includes(r.appointment_id)){store.update(r,{status:'cancelled',cancel_status:'cancelled'});return {success:true,status:'cancelled',...publicRecord(r)};}
  if(!body.includes(String(r.input.vehicle_year))||!body.includes(String(r.input.vehicle_model).toLowerCase()))return {success:false,status:'cancel_identity_unverified'};
  const ford=new URL(r.management_url).hostname==='www.guestxpui.ford.com';
  if(ford&&!body.includes(r.appointment_id))return {success:false,status:'cancel_identity_unverified'};
  if(!ford){const d=new Date(r.input.preferred_date+'T12:00:00Z');const date=d.toLocaleDateString('en-US',{month:'long',day:'2-digit',year:'numeric',timeZone:'UTC'}).toLowerCase();if(!body.includes(date))return {success:false,status:'cancel_identity_unverified'};}
  const first=p.getByRole('button',{name:ford?'Cancel Reservation':'Cancel Appointment',exact:true});if(await first.count()!==1)return {success:false,status:'cancel_control_unverified'};
  await first.click();await s.wait();
  s.stage='cancel_dialog_wait';
  const dialog=ford?p.getByRole('heading',{name:'Cancel Reservation',exact:true}):p.locator('[role="dialog"]').filter({hasText:'Are you sure you want to cancel your appointment?'});
  await dialog.waitFor({state:'visible',timeout:12000});
  const dialogText=await p.locator('body').innerText();
  if(!dialogText.includes(ford?'Are you sure you’d like to cancel your reservation?':'Are you sure you want to cancel your appointment?'))return {success:false,status:'cancel_review_unverified'};
  s.reyModal=!ford;s.finalButton=ford?'confirm cancel reservation':'Cancel Appointment';s.stage='cancel_review';
  return {success:true,status:'cancel_ready',appointment:publicRecord(r)};
 }catch(e){return {success:false,status:r.cancel_status==='unknown'?'cancellation_outcome_unknown':'cancel_review_error',failure_stage:s.stage,error_kind:e.name,error_detail:String(e.message||'').split('\n')[0].replace(/https?:\/\/\S+/g,'[URL]').slice(0,220)};}
 finally{s.busy=false;}
}
