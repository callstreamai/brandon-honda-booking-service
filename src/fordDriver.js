import { chromium } from 'playwright-core';
import {dealer, policyDecision, inputFingerprint, isServiceDate} from './policy.js';

// Observed GuestXP controls, November 5, 2026. Never execute caller-provided selectors or URLs.
const sessions = new Map();
const active = new Set();
const idleMs = 12 * 60 * 1000;
const exact = name => ({name, exact:true});
const fail = (status,message,extra={}) => ({success:false,status,message,...extra});
async function close(s) { await s?.browser?.close().catch(()=>{}); }
setInterval(()=>{ for(const [key,s] of sessions) if(Date.now()-s.touched>idleMs && !s.busy){sessions.delete(key);void close(s);} },60000).unref();

async function choose(select, value) {
  const options = await select.locator('option').evaluateAll(els=>els.map(e=>({label:e.textContent.trim(),value:e.value})));
  const match = options.filter(o=>o.label.toLowerCase()===String(value).trim().toLowerCase());
  if(match.length!==1) return {status:'choice_required', choices:options.map(o=>o.label).filter(Boolean)};
  await select.selectOption(match[0].value);
  return null;
}

async function newSession(input) {
  if(!process.env.BROWSERLESS_API_KEY) return fail('browserless_not_configured','Browserless credential has not been configured.');
  if(sessions.size>=10) return fail('capacity','All browser sessions are busy.');
  const region=process.env.BROWSERLESS_REGION || 'production-sfo.browserless.io';
  if(!/^[a-z0-9.-]+\.browserless\.io$/.test(region)) throw new Error('Invalid Browserless region');
  const browser=await chromium.connectOverCDP(`wss://${region}/chromium?token=${encodeURIComponent(process.env.BROWSERLESS_API_KEY)}&timeout=900000`);
  const context=await browser.newContext({timezoneId:dealer.timezone});
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const s={browser,context,page,touched:Date.now(),fingerprint:inputFingerprint(input),stage:'opening',slots:[],busy:true};
  try {
    await page.goto(dealer.scheduler,{waitUntil:'domcontentloaded',timeout:30000});
    await page.getByRole('button',exact('button to proceed as a new customer')).click();
    const make=page.getByLabel('Make',{exact:true});await make.waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('#make-input')?.disabled);
    for(const [field,label] of [['vehicle_make','Make'],['vehicle_year','Year'],['vehicle_model','Model'],['vehicle_type','Vehicle Type']]){
      if(!input[field]) {await close(s);return fail('vehicle_details_required',`Please provide ${label}.`,{missing_field:field});}
      const result=await choose(page.getByLabel(label,{exact:true}),input[field]);
      if(result){await close(s);return fail('vehicle_choice_required',`Select the scheduler's ${label}.`,{missing_field:field,choices:result.choices});}
    }
    // Ford supplies an estimated mileage. Do not present that estimate as the caller's mileage.
    const mileage=page.locator('#mileage-input');
    await mileage.fill(/^\d+$/.test(String(input.vehicle_mileage)) ? String(input.vehicle_mileage) : '');
    await page.getByRole('button',exact('Continue')).click();
    await page.getByRole('heading',exact('Selected Services Will Be Added To Your Reservation')).waitFor();
    await page.getByRole('checkbox').first().waitFor();
    s.menu=await page.getByRole('checkbox').evaluateAll(els=>els.map(el=>el.getAttribute('aria-label')||el.labels?.[0]?.textContent?.trim()||'').filter(Boolean));
    s.stage='services';return s;
  } catch(e){await close(s);throw e;}
}

async function atCalendar(s,input,decision) {
  const p=s.page;
  let labels=input.service_labels;
  if(typeof labels==='string') {try{labels=JSON.parse(labels);}catch{labels=labels.split('|').map(x=>x.trim());}}
  if(!Array.isArray(labels)||!labels.length) return fail('service_choice_required','Choose services from the returned menu.',{service_menu:s.menu});
  for(const label of labels){
    if(!s.menu.includes(label)) return fail('service_choice_required','Requested service is not in this vehicle’s menu.',{service_menu:s.menu});
    if(label==='Tire Repair/Replace' && !/tire.*replac|replac.*tire/i.test(input.service_concern||'')) return fail('policy_review_required','Tire repair is not offered. Confirm that replacement is the actual request.');
    await p.getByRole('checkbox',exact(label)).check();
  }
  await p.getByRole('button',exact('Continue')).click();
  await p.getByRole('heading',exact('Select a Service Location')).waitFor();
  await p.locator('[id="In-Person"]').check();
  await p.getByRole('button',exact('Continue')).click();
  await p.getByRole('heading',exact('While Your Vehicle is Serviced')).waitFor();
  if(!['dropoff','wait'].includes(input.transport_option)) return fail('transport_required','Choose dropoff or wait.');
  await p.locator(input.transport_option==='wait'?'[id="Waiter"]':'[id="Drop Off"]').check();
  await p.getByRole('button',exact('Continue')).click();
  await p.getByRole('heading',exact('Choose a Date and Time')).waitFor();
  const advisors=p.locator('#service-advisor');await advisors.waitFor();
  if(decision.advisor==='Nick') {
    const options=await advisors.locator('option').evaluateAll(els=>els.map(e=>({label:e.textContent.trim(),value:e.value})));
    // Never substitute the default advisor for Lincoln non-express work.
    const nick=options.filter(x=>/\bnick\b/i.test(x.label));
    if(nick.length!==1) return fail('advisor_unavailable','Nick is required for this Lincoln request but is not uniquely selectable.');
    await advisors.selectOption(nick[0].value);
  }
  s.stage='calendar';return null;
}

async function selectDate(p,iso) {
  if(!isServiceDate(iso)) return fail('closed_date','Service is closed weekends; select a weekday.');
  const visible=p.locator(`[id="${iso}"]`);
  if(await visible.count()) {await visible.check();return null;}
  await p.getByRole('button',exact('view more date options on calendar')).click();
  const [year,month,day]=iso.split('-').map(Number);
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  await p.getByRole('combobox',{name:'Month',exact:true}).selectOption({label:months[month-1]});
  const yrs=p.getByRole('combobox',{name:'Year',exact:true});
  const choice=await choose(yrs,String(year));
  if(choice) return fail('date_out_of_horizon','The requested year is outside the scheduler calendar.');
  // Calendar padding may repeat a day number. Reject ambiguity instead of selecting another month.
  const dayButton=p.getByRole('button',exact(String(day)));
  if(await dayButton.count()!==1) return fail('calendar_ambiguous','The date needs manual calendar verification.');
  await dayButton.click();await p.getByRole('button',exact('Update Results')).click();return null;
}

export async function operate(operation,input) {
  const key=String(input.call_id||'').trim();
  if(!key||key.includes('{{')) return fail('call_id_required','A unique call identifier is required.');
  if(operation==='book') return fail('write_disabled','Final booking is disabled until the Ford review/confirmation screens and an authorized booking fixture are validated.');
  const decision=policyDecision(input);
  if(decision.action!=='schedule') return fail('policy_'+decision.action,decision.reason,{policy:decision});
  let s=sessions.get(key);
  if(active.has(key)||s?.busy) return fail('session_busy','This caller’s scheduler operation is already running.');
  active.add(key);
  try {
    if(s&&(s.fingerprint!==inputFingerprint(input)||Date.now()-s.touched>idleMs||s.page.isClosed())) {sessions.delete(key);await close(s);s=null;}
    if(!s){s=await newSession(input);if(s.success===false)return s;sessions.set(key,s);}
    s.busy=true;s.touched=Date.now();
    if(operation==='prepare') return {success:true,status:'services_ready',service_menu:s.menu};
    if(s.stage==='services'){const result=await atCalendar(s,input,decision);if(result){sessions.delete(key);await close(s);return result;}}
    if(s.stage!=='calendar') return fail('unexpected_screen','The scheduler needs verification.');
    const date=input.preferred_date;
    const result=await selectDate(s.page,date);if(result)return result;
    // Wait until the calendar settles. These time selectors are inspected as DOM-backed labels;
    // no generated time can become an appointment option.
    await s.page.waitForFunction(()=>document.body.innerText.includes('No service times available') || [...document.querySelectorAll('input[type="radio"]')].some(el=>/\d{1,2}:\d{2}\s*[ap]m/i.test(el.labels?.[0]?.innerText||el.getAttribute('aria-label')||'')),null,{timeout:15000});
    const slots=await s.page.getByRole('radio').evaluateAll(els=>els.map(el=>el.getAttribute('aria-label')||el.labels?.[0]?.innerText?.trim()||'').filter(x=>/\d{1,2}:\d{2}\s*[ap]m/i.test(x)));
    s.slots=[...new Set(slots)];s.date=date;
    return {success:true,status:s.slots.length?'availability_found':'no_availability',available_slots:s.slots,preferred_date:date,timezone:dealer.timezone,booking_enabled:false};
  } catch {
    if(s){sessions.delete(key);await close(s);}
    // Never return connection URLs, browser errors, page contents, or caller data to logs.
    return fail('scheduler_error','The Ford scheduler could not complete this read. No booking submission was attempted.');
  } finally {if(s)s.busy=false;active.delete(key);}
}

export async function shutdown(){await Promise.all([...sessions.values()].map(close));sessions.clear();}
