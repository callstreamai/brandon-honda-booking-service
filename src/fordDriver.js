import { chromium } from 'playwright-core';
import {dealer, policyDecision, inputFingerprint, isServiceDate} from './policy.js';
import {watchReadRequests} from './readiness.js';

// Observed GuestXP controls, November 5, 2026. Never execute caller-provided selectors or URLs.
const sessions = new Map();
const active = new Set();
const idleMs = 2 * 60 * 1000;
const sessionLimit=Math.max(1,Math.min(10,Number(process.env.MAX_BROWSER_SESSIONS)||2));
let pendingConnections=0;
export function browserStats(){return {active_sessions:sessions.size,connecting:pendingConnections,session_limit:sessionLimit};}
const exact = name => ({name, exact:true});
const fail = (status,message,extra={}) => ({success:false,status,message,...extra});
async function close(s) { await s?.browser?.close().catch(()=>{}); }
async function selectLabeled(input) {
  if(!await input.isChecked())await input.locator('xpath=ancestor::label[1]').click();
  if(!await input.isChecked())throw new Error('Labeled selection was not applied');
}
setInterval(()=>{ for(const [key,s] of sessions) if(Date.now()-s.touched>idleMs && !s.busy){sessions.delete(key);void close(s);} },60000).unref();

async function choose(select, value) {
  const escaped=String(value).trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const wanted=select.locator('option').filter({hasText:new RegExp('^'+escaped+'$','i')});
  try {await wanted.first().waitFor({state:'attached',timeout:12000});}catch{}
  const options=(await select.locator('option').allTextContents()).map(x=>x.trim());
  const match=options.filter(x=>x.toLowerCase()===String(value).trim().toLowerCase());
  if(match.length!==1) return {status:'choice_required',choices:options.filter(Boolean)};
  await select.selectOption({label:match[0]});
  return null;
}

async function newSession(input) {
  if(!process.env.BROWSERLESS_API_KEY) return fail('browserless_not_configured','Browserless credential has not been configured.');
  if(sessions.size+pendingConnections>=sessionLimit) return fail('capacity','All configured browser sessions are busy.');
  pendingConnections++;
  try {
  const region=process.env.BROWSERLESS_REGION || 'production-sfo.browserless.io';
  if(!/^[a-z0-9.-]+\.browserless\.io$/.test(region)) throw new Error('Invalid Browserless region');
  let browser;
  try {browser=await chromium.connectOverCDP(`wss://${region}/chromium?token=${encodeURIComponent(process.env.BROWSERLESS_API_KEY)}&timeout=900000`);}
  catch {const e=new Error('Browserless connection failed');e.stage='browser_connection';throw e;}
  let context,page;
  try {context=await browser.newContext({timezoneId:dealer.timezone});page=await context.newPage();}
  catch {await browser.close().catch(()=>{});throw new Error('Browser context could not be created');}
  page.setDefaultTimeout(12000);
  const s={browser,context,page,waitForReads:watchReadRequests(page),touched:Date.now(),fingerprint:inputFingerprint(input),stage:'opening',slots:[],busy:true};
  try {
    s.stage='scheduler_open';
    await page.goto(dealer.scheduler,{waitUntil:'domcontentloaded',timeout:30000});
    s.stage='guest_entry';await page.getByRole('button',exact('button to proceed as a new customer')).click();
    const make=page.getByLabel('Make',{exact:true});await make.waitFor({state:'visible'});
    for(const [field,label] of [['vehicle_make','Make'],['vehicle_year','Year'],['vehicle_model','Model'],['vehicle_type','Vehicle Type']]){
      s.stage=field;
      if(!input[field]) {await close(s);return fail('vehicle_details_required',`Please provide ${label}.`,{missing_field:field});}
      const result=await choose(page.getByLabel(label,{exact:true}),input[field]);
      if(result){await close(s);return fail('vehicle_choice_required',`Select the scheduler's ${label}.`,{missing_field:field,choices:result.choices});}
    }
    s.selectedVehicle={};
    for(const [key,id]of [['make','make-input'],['year','year-input'],['model','model-input'],['type','vehicle-type-input']])s.selectedVehicle[key]=(await page.locator('#'+id+' option:checked').textContent()).trim();
    // Ford supplies an estimated mileage. Do not present that estimate as the caller's mileage.
    s.stage='vehicle_mileage';const mileage=page.locator('#mileage-input');
    await mileage.fill(/^\d+$/.test(String(input.vehicle_mileage)) ? String(input.vehicle_mileage) : '');
    s.stage='load_services';await page.getByRole('button',exact('Continue')).click();
    await page.getByRole('heading',exact('Selected Services Will Be Added To Your Reservation')).waitFor();
    await page.getByRole('checkbox').first().waitFor({state:'attached'});
    s.menu=[];
    const boxes=page.getByRole('checkbox');
    for(let i=0;i<await boxes.count();i++)s.menu.push((await boxes.nth(i).locator('xpath=ancestor::label[1]').innerText()).trim());
    s.stage='services';return s;
  } catch(cause){
    const e=new Error('Ford read failed');e.stage=s.stage;
    const message=String(cause?.message||'');
    e.detail=message.split('\n')[0].replace(/https?:\/\/\S+|wss?:\/\/\S+/g,'[URL]').split(process.env.BROWSERLESS_API_KEY||'__no_key__').join('[secret]').slice(0,240);
    e.kind=/strict mode violation/i.test(message)?'ambiguous_control':/closed|disconnect/i.test(message)?'browser_closed':cause?.name==='TimeoutError'?'control_timeout':'browser_action_error';
    e.screen=await page.locator('h1,h2').allTextContents().catch(()=>[]);
    await close(s);throw e;
  }
  } finally {pendingConnections--;}
}

async function atCalendar(s,input,decision) {
  const p=s.page;
  s.stage='select_services';
  let labels=input.service_labels;
  if(typeof labels==='string') {try{labels=JSON.parse(labels);}catch{labels=labels.split('|').map(x=>x.trim());}}
  if(!Array.isArray(labels)||!labels.length) return fail('service_choice_required','Choose services from the returned menu.',{service_menu:s.menu});
  for(const label of labels){
    if(!s.menu.includes(label)) return fail('service_choice_required','Requested service is not in this vehicle’s menu.',{service_menu:s.menu});
    if(label==='Tire Repair/Replace' && !/tire.*replac|replac.*tire/i.test(input.service_concern||'')) return fail('policy_review_required','Tire repair is not offered. Confirm that replacement is the actual request.');
    await selectLabeled(p.getByRole('checkbox',exact(label)));
  }
  s.selectedServices=[...labels];
  await p.getByRole('button',exact('Continue')).click();
  s.stage='service_location';
  await p.getByRole('heading',exact('Select a Service Location')).waitFor();
  await selectLabeled(p.locator('[id="In-Person"]'));
  await p.getByRole('button',exact('Continue')).click();
  s.stage='choose_transport';
  const transportForm=p.getByLabel('Choose a Transportation Option',{exact:true});
  await transportForm.getByRole('heading',exact('While Your Vehicle is Serviced')).waitFor();
  if(!['dropoff','wait'].includes(input.transport_option)) return fail('transport_required','Choose dropoff or wait.');
  await selectLabeled(transportForm.locator(input.transport_option==='wait'?'[id="Waiter"]':'[id="Drop Off"]'));
  s.selectedTransport=input.transport_option;
  await transportForm.getByRole('button',exact('Continue')).click();
  s.stage='open_calendar';
  await p.getByRole('heading',exact('Choose a Date and Time')).waitFor();
  const advisors=p.locator('#service-advisor');await advisors.waitFor();
  await s.waitForReads();
  if(decision.advisor==='Nick') {
    const options=(await advisors.locator('option').allTextContents()).map(label=>({label:label.trim()}));
    // Never substitute the default advisor for Lincoln non-express work.
    const nick=options.filter(x=>/\bnick\b/i.test(x.label));
    if(nick.length!==1) return fail('advisor_unavailable','Nick is required for this Lincoln request but is not uniquely selectable.');
    await advisors.selectOption({label:nick[0].label});
  }
  s.stage='calendar';return null;
}

async function selectDate(p,iso,waitForReads) {
  if(!isServiceDate(iso)) return fail('closed_date','Service is closed weekends; select a weekday.');
  const visible=p.locator(`[id="${iso}"]`);
  if(await visible.count()) {await selectLabeled(visible);return null;}
  await p.getByRole('button',exact('view more date options on calendar')).click();
  const [year,month,day]=iso.split('-').map(Number);
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  await p.getByRole('combobox',{name:'Month',exact:true}).selectOption({label:months[month-1]});
  const yrs=p.getByRole('combobox',{name:'Year',exact:true});
  const choice=await choose(yrs,String(year));
  if(choice) return fail('date_out_of_horizon','The requested year is outside the scheduler calendar.');
  await waitForReads();
  // Ford uses react-date-range: passive cells belong to an adjacent month.
  const dayButton=p.getByRole('button',exact(String(day))).and(p.locator('button.rdrDay:not(.rdrDayPassive)'));
  if(await dayButton.count()!==1) return fail('calendar_ambiguous','The date needs manual calendar verification.');
  if(!await dayButton.isEnabled()||/rdrDayDisabled/.test(await dayButton.getAttribute('class')||''))return fail('date_out_of_horizon','The requested date is not selectable.');
  await dayButton.click();await p.getByRole('button',exact('Update Results')).click();return null;
}

export async function operate(operation,input) {
  const key=String(input.call_id||'').trim();
  if(!key||key.includes('{{')) return fail('call_id_required','A unique call identifier is required.');
  if(operation==='close'){
    if(active.has(key))return fail('session_busy','A scheduler operation is running.');
    const s=sessions.get(key);sessions.delete(key);await close(s);
    return {success:true,status:'session_closed'};
  }
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
    const result=await selectDate(s.page,date,s.waitForReads);if(result)return result;
    // Ford CSP forbids eval-based waits. Use native locator operations and network settling.
    await s.waitForReads();
    const selectedDate=s.page.locator(`[id="${date}"]`);await selectedDate.waitFor({state:'attached'});
    if(!await selectedDate.isChecked())return fail('calendar_unverified','The requested date was not selected.');
    const radios=s.page.getByRole('radio');const slots=[];
    for(let i=0;i<await radios.count();i++){
      const r=radios.nth(i);let label=await r.getAttribute('aria-label');
      if(!await r.isEnabled())continue;
      if(!label)label=await r.locator('xpath=ancestor::label[1]').innerText().catch(()=>'');
      if(/\d{1,2}:\d{2}\s*[ap]m/i.test(label))slots.push(label.trim());
    }
    if(!slots.length && !await s.page.getByText('No service times available during the selected time period.',{exact:false}).count())return fail('calendar_unverified','The current calendar screen could not be verified.');
    s.slots=[...new Set(slots)];s.date=date;
    return {success:true,status:s.slots.length?'availability_found':'no_availability',available_slots:s.slots,preferred_date:date,timezone:dealer.timezone,booking_enabled:false,verified_vehicle:s.selectedVehicle,verified_services:s.selectedServices,verified_transport:s.selectedTransport,calendar_date_selected:true};
  } catch(e) {
    if(s){sessions.delete(key);await close(s);}
    // Never return connection URLs, browser errors, page contents, or caller data to logs.
    const diagnostic=e.detail||String(e.message||'').split('\n')[0].replace(/https?:\/\/\S+|wss?:\/\/\S+/g,'[URL]').split(process.env.BROWSERLESS_API_KEY||'__no_key__').join('[secret]').slice(0,240);
    return fail('scheduler_error','The Ford scheduler could not complete this read. No booking submission was attempted.',{failure_stage:e.stage||s?.stage||'browser_setup',failure_kind:e.kind||e.name||'connection_error',screen_headings:e.screen||[],diagnostic_detail:diagnostic});
  } finally {if(s)s.busy=false;active.delete(key);}
}

export async function shutdown(){await Promise.all([...sessions.values()].map(close));sessions.clear();}
