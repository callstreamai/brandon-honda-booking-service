import crypto from 'node:crypto';
import {isServiceDate} from './policy.js';
import {parseTimeLabel} from './slots.js';
const clean=value=>String(value||'').trim().replace(/\s+/g,' ').toLowerCase();
const digits=value=>String(value||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
function labels(value){if(Array.isArray(value))return value;try{return JSON.parse(value);}catch{return String(value||'').split('|');}}
export function isAuthorizedTestBooking(input,env=process.env,now=Date.now()){
  if(!env.AUTHORIZED_TEST_CALL_ID||input.call_id!==env.AUTHORIZED_TEST_CALL_ID||Date.parse(env.AUTHORIZED_TEST_EXPIRES_AT||'')<=now||!Number.isFinite(Date.parse(env.AUTHORIZED_TEST_EXPIRES_AT||'')))return false;
  if(!env.AUTHORIZED_TEST_PHONE||digits(input.caller_phone)!==digits(env.AUTHORIZED_TEST_PHONE))return false;
  if(!env.AUTHORIZED_TEST_CUSTOMER_NAME||clean(input.customer_name)!==clean(env.AUTHORIZED_TEST_CUSTOMER_NAME))return false;
  if(!env.AUTHORIZED_TEST_EMAIL||clean(input.customer_email)!==clean(env.AUTHORIZED_TEST_EMAIL))return false;
  const vehicle=[input.vehicle_year,input.vehicle_make,input.vehicle_model,input.vehicle_type].map(clean).join('|');
  if(!env.AUTHORIZED_TEST_VEHICLE||vehicle!==env.AUTHORIZED_TEST_VEHICLE.split('|').map(clean).join('|'))return false;
  const requested=labels(input.service_labels);
  if(!Array.isArray(requested)||requested.length!==1||clean(requested[0])!==clean(env.AUTHORIZED_TEST_SERVICE))return false;
  if(!env.AUTHORIZED_TEST_SERVICE||clean(input.transport_option)!==clean(env.AUTHORIZED_TEST_TRANSPORT)||!env.AUTHORIZED_TEST_TRANSPORT)return false;
  return [true,'true'].includes(input.readback_confirmed)&&isServiceDate(input.preferred_date)&&!!parseTimeLabel(input.preferred_time);
}
const finalAction=/^(Schedule|(confirm|book|schedule|submit|complete)( your| my)? (appointment|reservation|service)( now)?)$/i;
async function visibleButtons(page){
  const buttons=page.getByRole('button');const result=[];
  for(let i=0;i<await buttons.count();i++){const b=buttons.nth(i);if(!await b.isVisible())continue;const name=(await b.getAttribute('aria-label')||await b.innerText()).trim();if(name)result.push({name,enabled:await b.isEnabled()});}
  return result;
}
export async function inspectTestBooking(s,{screenshot=false}={}){
  const page=s.page;
  if(page.isClosed())return {success:false,status:'booking_page_closed',booking_status:s.bookingStatus||'unknown'};
  const result={success:false,status:s.stage,booking_status:s.bookingStatus||'not_submitted',headings:await page.locator('h1,h2,h3').allTextContents(),buttons:await visibleButtons(page),screen_text:(await page.locator('body').innerText()).slice(0,18000),review_token:s.reviewToken||null};
  if(screenshot)result.screenshot_base64=(await page.screenshot({fullPage:true})).toString('base64');
  return result;
}
export async function prepareTestReview(s,input){
  const p=s.page;
  if(s.stage!=='calendar'||s.date!==input.preferred_date||!s.slots.includes(input.preferred_time))return {success:false,status:'fresh_availability_required'};
  const slot=p.getByRole('radio',{name:input.preferred_time,exact:true});
  if(await slot.count()!==1||!await slot.isEnabled())return {success:false,status:'selected_slot_unavailable'};
  s.stage='booking_review_preparing';
  try{
    if(!await slot.isChecked())await slot.locator('xpath=ancestor::label[1]').click();
    if(!await slot.isChecked())throw new Error('Selected time was not applied');
    await p.getByRole('button',{name:'Continue',exact:true}).click();
    await p.getByRole('heading',{name:'Enter Your Information',exact:true}).waitFor();
    const words=String(input.customer_name).trim().split(/\s+/);const first=words.shift();const last=words.join(' ');
    // This endpoint is exclusively for the explicitly approved fictional test fixture.
    // Keep the test marker visible to dealership staff even if no comments field exists.
    await p.getByLabel('First Name',{exact:true}).fill(first+' RPA TEST');
    await p.getByLabel('Last Name',{exact:true}).fill(last);
    if(input.customer_email&&input.customer_email!=='none')await p.getByLabel('Email Address',{exact:true}).fill(input.customer_email);
    await p.getByLabel('Primary Phone (Mobile)',{exact:true}).fill(digits(input.caller_phone));
    await s.waitForReads();
    s.contactSubmitted=true;
    await p.getByRole('button',{name:'Continue',exact:true}).click();
    await s.waitForReads();
    s.stage='booking_review';
    await p.getByRole('heading',{name:'Reservation Summary',exact:true}).waitFor();
    const comments=p.getByRole('textbox');
    if(await comments.count()===1)await comments.fill(('RPA TEST BOOKING: fictional Ford vehicle. '+(input.booking_notes||'')).slice(0,250));
    const both=p.getByRole('radio',{name:input.confirmation_method||'Both',exact:true});
    if(await both.count()===1){if(!await both.isChecked())await both.locator('xpath=ancestor::label[1]').click();if(!await both.isChecked())throw new Error('Communication preference not applied');}
    else throw new Error('Communication preference needs mapping');
    const snapshot=await inspectTestBooking(s);
    const candidates=snapshot.buttons.filter(b=>b.enabled&&finalAction.test(b.name));
    if(candidates.length===1){s.finalButton=candidates[0].name;s.reviewToken=crypto.randomUUID();snapshot.review_token=s.reviewToken;snapshot.status='booking_review_ready';}
    else snapshot.status='booking_review_needs_mapping';
    return snapshot;
  }catch{
    s.bookingStatus=s.contactSubmitted?'unknown':'not_submitted';
    s.stage='booking_review_error';return await inspectTestBooking(s);
  }
}
export async function commitTestBooking(s,input){
  if(s.writeAttempted)return {...await inspectTestBooking(s),status:'booking_write_already_attempted'};
  if(s.stage!=='booking_review'||!s.reviewToken||input.review_token!==s.reviewToken||!s.finalButton)return {success:false,status:'booking_review_required'};
  const button=s.page.getByRole('button',{name:s.finalButton,exact:true});
  if(await button.count()!==1||!await button.isEnabled())return {success:false,status:'booking_review_changed'};
  // Set before the click. Neither an HTTP retry nor an uncertain response may click twice.
  s.writeAttempted=true;s.bookingStatus='unknown';s.stage='booking_result_requires_verification';
  try{await button.click();await s.waitForReads();}catch{}
  // A first live test must be verified from the actual confirmation and a fresh lookup.
  // This does not turn a successful HTTP request into a claimed appointment.
  return await inspectTestBooking(s);
}
