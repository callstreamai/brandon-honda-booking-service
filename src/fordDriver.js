import {applyValetAddress,isValet} from './valet.js';
import { chromium } from 'playwright-core';
import {accountTypeFor,selectAccountType} from './accountType.js';
import {resolveServices} from './serviceRecovery.js';
import {manualConcernAvailable,selectManualConcern} from './manualConcern.js';
import {allowedTestCaller,bookingStore} from './bookingStore.js';
import {bookVoiceTest} from './voiceBooking.js';
import {dealer, policyDecision, inputFingerprint, isServiceDate} from './policy.js';
import {watchReadRequests} from './readiness.js';
import {parseTimeLabel} from './slots.js';
import {nearestYears,equivalentModel,selectionNote,appointmentNotes,readbackFields} from './schedulerChoices.js';
import {isAuthorizedTestBooking,prepareTestReview,inspectTestBooking,commitTestBooking} from './testBooking.js';

// Observed GuestXP controls, November 5, 2026. Never execute caller-provided selectors or URLs.
const sessions = new Map();
const preparations=new Map();
const vehicleFingerprint=input=>JSON.stringify(['customer_account_type','vehicle_make','vehicle_year','vehicle_model','vehicle_type','vehicle_mileage'].map(k=>input[k]??null));
const active = new Set();
const idleMs = 10 * 60 * 1000;
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
setInterval(()=>{for(const [key,p]of preparations)if(Date.now()-p.at>idleMs)preparations.delete(key); for(const [key,s] of sessions) if(Date.now()-s.touched>idleMs && !s.busy){sessions.delete(key);void close(s);} },60000).unref();

async function choose(select, value, settled=false) {
  const escaped=String(value).trim().replace(/[\s-]/g,'').split('').map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[\\s-]*');
  const wanted=select.locator('option').filter({hasText:new RegExp('^'+escaped+'$','i')});
  if(!settled)try {await wanted.first().waitFor({state:'attached',timeout:12000});}catch{}
  const options=(await select.locator('option').allTextContents()).map(x=>x.trim());
  const normalized=x=>String(x).toLowerCase().replace(/[\s-]/g,'');
  const match=options.filter(x=>normalized(x)===normalized(value));
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
  try {context=await browser.newContext({timezoneId:dealer.timezone,viewport:{width:1440,height:1000}});page=await context.newPage();}
  catch {await browser.close().catch(()=>{});throw new Error('Browser context could not be created');}
  page.setDefaultTimeout(12000);
  const s={browser,context,page,waitForReads:watchReadRequests(page),touched:Date.now(),fingerprint:inputFingerprint(input),vehicleFingerprint:vehicleFingerprint(input),stage:'opening',slots:[],busy:true};
  try {
    s.receipts=[];s.receiptReads=[];
    page.on('response',response=>{if(!s.writeAttempted||s.receipts.length>=12||!['fetch','xhr'].includes(response.request().resourceType()))return;const task=(async()=>{try{if(!(response.headers()['content-type']||'').includes('json'))return;const value=await response.json();s.receipts.push({path:new URL(response.url()).pathname,status:response.status(),value});}catch{}})();s.receiptReads.push(task);});
    s.stage='scheduler_open';
    await page.goto(dealer.scheduler,{waitUntil:'domcontentloaded',timeout:30000});
    s.stage='account_selection';s.accountType=await selectAccountType(page,input.customer_account_type);
    s.stage='guest_entry';await page.getByRole('button',exact('button to proceed as a new customer')).click();
    const make=page.getByLabel('Make',{exact:true});await make.waitFor({state:'visible'});
    for(const [field,label] of [['vehicle_make','Make'],['vehicle_year','Year'],['vehicle_model','Model'],['vehicle_type','Vehicle Type']]){
      s.stage=field;
      if(!input[field]) {await close(s);return fail('vehicle_details_required',`Please provide ${label}.`,{missing_field:field});}
      const completion=[true,'true'].includes(input.completion_fallbacks);
      await s.waitForReads();
      let result=await choose(page.getByLabel(label,{exact:true}),input[field],completion);
      if(result&&completion&&field==='vehicle_year'){
        const year=nearestYears(input.vehicle_year,result.choices)[0];
        if(year){result=await choose(page.getByLabel(label,{exact:true}),year,true);await s.waitForReads();}
      }
      if(result&&completion&&field==='vehicle_model'){
        const model=equivalentModel(input.vehicle_model,result.choices);
        if(model)result=await choose(page.getByLabel(label,{exact:true}),model,true);
        else {
          const years=(await page.getByLabel('Year',{exact:true}).locator('option').allTextContents()).map(x=>x.trim());
          for(const year of nearestYears(input.vehicle_year,years)){
            await choose(page.getByLabel('Year',{exact:true}),year,true);await s.waitForReads();
            const choices=(await page.getByLabel('Model',{exact:true}).locator('option').allTextContents()).map(x=>x.trim());
            const matched=equivalentModel(input.vehicle_model,choices);
            if(matched){result=await choose(page.getByLabel('Model',{exact:true}),matched,true);break;}
          }
        }
      }
      if(result&&completion&&field==='vehicle_type'&&[true,'true'].includes(input.fuel_defaulted)){
        const choices=result.choices.filter(x=>/^(Gas|Hybrid|Diesel|Electric)$/.test(x));
        if(choices.length===1)result=await choose(page.getByLabel(label,{exact:true}),choices[0],true);
      }
      if(result){await close(s);return fail('vehicle_choice_required',`The supplied ${label} is not listed for this vehicle selection.`,{missing_field:field,choices:result.choices,adapter_question:`I have ${input.vehicle_year} ${input.vehicle_make} ${input.vehicle_model}. The online scheduler does not list that ${label.toLowerCase()} for this selection. Would you like me to connect you with Service to arrange the appointment?`});}
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
  const resolution=await resolveServices(input,s.menu,process.env,fetch,{manualConcern:await manualConcernAvailable(p)});
  s.serviceResolution=resolution;
  if(resolution.status!=='services_resolved')return fail(resolution.status,'Service matching needs a supported next step.',{...resolution,service_menu:s.menu,service_labels:'none',available_slots:[],preferred_time:'none',readback_confirmed:false});
  let labels=resolution.service_labels;
  if(labels.includes('The Works®'))labels=labels.filter(x=>!['Oil Change','Tire Rotation'].includes(x));
  if(resolution.service_recovery_action==='manual_description'){
    const result=await selectManualConcern(s,input);if(result)return result;
  }else for(const label of labels){
    if(!s.menu.includes(label)) return fail('service_choice_required','Requested service is not in this vehicle’s menu.',{service_menu:s.menu});
    const checkbox=p.getByRole('checkbox',exact(label));
    if(!await checkbox.isChecked())await checkbox.locator('xpath=ancestor::label[1]').click();
    await s.waitForReads();
    const addService=p.getByRole('button',exact('Add Service'));
    if(await addService.isVisible()){
      if(await p.getByRole('heading',exact(label)).count()!==1||!await addService.isEnabled())return fail('service_details_required','This service needs additional choices before availability can be checked.');
      await addService.click();await s.waitForReads();
    }
    if(!await checkbox.isChecked())return fail('service_not_selected','The requested service was not selected.');
  }
  input.service_labels=labels.join('|');
  s.fingerprint=inputFingerprint(input);
  s.selectedServices=[...labels];
  if([true,'true'].includes(input.completion_fallbacks)){
    s.selectionNote=selectionNote(input,s.selectedVehicle,labels);
    s.appointmentNotes=appointmentNotes(input,s.selectedVehicle,labels);
  }
  await p.getByRole('button',exact('Continue')).click();
  s.stage='service_location';
  await p.getByRole('heading',exact('Select a Service Location')).waitFor();
  if(isValet(input)){
    await selectLabeled(p.locator('[id="Pickup and Delivery"]'));
    await p.getByRole('button',exact('Continue')).click();
    s.stage='pickup_address';const result=await applyValetAddress(s,input);if(result)return result;
    s.selectedTransport='pickup';
  }else{
    await selectLabeled(p.locator('[id="In-Person"]'));
    await p.getByRole('button',exact('Continue')).click();
    s.stage='choose_transport';const transportForm=p.getByLabel('Choose a Transportation Option',{exact:true});
    await transportForm.getByRole('heading',exact('While Your Vehicle is Serviced')).waitFor();
    if(!['dropoff','wait'].includes(input.transport_option))return fail('transport_required','Choose dropoff or wait.');
    await selectLabeled(transportForm.locator(input.transport_option==='wait'?'[id="Waiter"]':'[id="Drop Off"]'));
    s.selectedTransport=input.transport_option;await transportForm.getByRole('button',exact('Continue')).click();
  }
  s.stage='open_calendar';
  await p.getByRole('heading',exact('Choose a Date and Time')).waitFor();
  const advisors=p.locator('#service-advisor');await advisors.waitFor();
  await s.waitForReads();
  if(decision.advisor==='Nick') {
    const options=(await advisors.locator('option').allTextContents()).map(label=>({label:label.trim()}));
    // Never substitute the default advisor for Lincoln work; the final dealer policy requires Nick for all Lincoln appointments.
    const nick=options.filter(x=>/\bnick\b/i.test(x.label));
    if(nick.length!==1) return fail('advisor_unavailable','Nick is required for this Lincoln request but is not uniquely selectable.',{advisor_options:options.map(x=>x.label)});
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
  if(operation!=='close'){const type=accountTypeFor(input);if(!type)return fail('account_type_required','Confirm whether this is an individual or business/fleet reservation.');input={...input,customer_account_type:type};}
  if(!key||key.includes('{{')) return fail('call_id_required','A unique call identifier is required.');
  if(operation==='prepare'&&input.background_prepare===true){
    if(!preparations.has(key)&&!sessions.has(key)){
      if(preparations.size>=20)return fail('capacity','All browser preparation slots are busy.');
      const entry={at:Date.now(),promise:operate('prepare',{...input,background_prepare:false})};preparations.set(key,entry);
    }
    return {success:true,status:'preparing',service_menu:[],next_step:input.service_concern?'policy_hook':'service_need'};
  }
  if(['availability','close'].includes(operation)&&preparations.has(key)){const entry=preparations.get(key);const result=await entry.promise;preparations.delete(key);if(operation!=='close'&&result.success===false)return result;}
  if(operation==='close'){
    if(active.has(key))return fail('session_busy','A scheduler operation is running.');
    const s=sessions.get(key);sessions.delete(key);await close(s);
    return {success:true,status:'session_closed'};
  }
  const testOperation=['book','review','inspect'].includes(operation);
  if(testOperation&&!isAuthorizedTestBooking(input)&&!allowedTestCaller(input))return fail('write_disabled','General booking is disabled. This operation requires the exact, unexpired, user-approved test fixture.');
  // Preparing only loads the vehicle service menu; valet address validation belongs to availability/review.
  const decision=policyDecision(operation==='prepare'&&input.transport_option==='pickup'?{...input,transport_option:'dropoff'}:input);
  if(decision.action!=='schedule') return fail('policy_'+decision.action,decision.reason,{policy:decision});
  let s=sessions.get(key);
  if(active.has(key)||s?.busy) return fail('session_busy','This caller’s scheduler operation is already running.');
  active.add(key);
  try {
    if(testOperation){
      if(operation==='book'&&allowedTestCaller(input)){
        const prior=bookingStore().byCall(input.call_id);
        if(prior||s&&s.fingerprint===inputFingerprint(input)&&!s.page.isClosed()){if(s){s.busy=true;s.touched=Date.now();}return await bookVoiceTest(s,input);}
      }
      if(!s||s.fingerprint!==inputFingerprint(input)||s.page.isClosed())return fail('fresh_availability_required','The approved booking needs a matching active scheduler session.');
      s.busy=true;s.touched=Date.now();
      if(operation==='inspect'){const view=await inspectTestBooking(s,{screenshot:input.include_screenshot===true});if(input.include_receipts===true&&allowedTestCaller(input))view.response_receipts=s.receipts||[];return view;}
      if(operation==='book')return await commitTestBooking(s,input);
      return await prepareTestReview(s,input);
    }
    if(s?.stage==='services'&&s.vehicleFingerprint===vehicleFingerprint(input))s.fingerprint=inputFingerprint(input);
    if(s&&(s.fingerprint!==inputFingerprint(input)||Date.now()-s.touched>idleMs||s.page.isClosed())) {sessions.delete(key);await close(s);s=null;}
    if(!s){s=await newSession(input);if(s.success===false)return s;sessions.set(key,s);}
    s.busy=true;s.touched=Date.now();
    if(operation==='prepare') return {success:true,status:'services_ready',service_menu:s.menu,verified_account_type:s.accountType,next_step:input.service_concern?'policy_hook':'service_need'};
    if(s.stage==='services'){const result=await atCalendar(s,input,decision);if(result){if(['service_choice_required','service_clarification_required','service_staff_required'].includes(result.status)){s.stage='services';return result;}sessions.delete(key);await close(s);return result;}}
    if(s.stage!=='calendar') return fail('unexpected_screen','The scheduler needs verification.');
    const earliest=input.preferred_date==='earliest'||(!/^\d{4}-\d{2}-\d{2}$/.test(String(input.preferred_date||''))&&[true,'true'].includes(input.earliest_requested));
    let date=earliest?new Intl.DateTimeFormat('en-CA',{timeZone:dealer.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()):input.preferred_date;
    const nextDay=d=>new Date(new Date(d+'T12:00:00Z').getTime()+86400000).toISOString().slice(0,10);
    if(earliest)while(!isServiceDate(date))date=nextDay(date);
    const searched=[];
    for(let attempt=0;attempt<(earliest?5:1);attempt++){
    searched.push(date);
    const result=await selectDate(s.page,date,s.waitForReads);if(result){if(earliest&&result.status==='date_out_of_horizon'&&attempt<4){do{date=nextDay(date);}while(!isServiceDate(date));continue;}return result;}
    // Ford CSP forbids eval-based waits. Use native locator operations and network settling.
    await s.waitForReads();
    const selectedDate=s.page.locator(`[id="${date}"]`);await selectedDate.waitFor({state:'attached'});
    if(!await selectedDate.isChecked())return fail('calendar_unverified','The requested date was not selected.');
    const radios=s.page.getByRole('radio');const slots=[];s.slotDetails=[];
    // Independent reads on the settled calendar can share one browser round trip window.
    // Keep all selection/booking actions sequential and preserve displayed slot order.
    const count=await radios.count(),rows=[];
    for(let start=0;start<count;start+=8){
      rows.push(...await Promise.all(Array.from({length:Math.min(8,count-start)},async(_,offset)=>{
        const r=radios.nth(start+offset);
        const [enabled,aria,id]=await Promise.all([r.isEnabled(),r.getAttribute('aria-label'),r.getAttribute('id')]);
        if(!enabled)return null;
        const label=aria||await r.locator('xpath=ancestor::label[1]').innerText().catch(()=>'');
        const time=parseTimeLabel(label);
        return time&&(!isValet(input)||(time.minutes>=480&&time.minutes<=900))?{...time,id}:null;
      })));
    }
    for(const row of rows.filter(Boolean)){slots.push(row.text);s.slotDetails.push(row);}
    if(!slots.length && !await s.page.getByText('No service times available during the selected time period.',{exact:false}).count())return fail('calendar_unverified','The current calendar screen could not be verified.');
    s.slots=[...new Set(slots)];s.date=date;
    if(earliest&&!s.slots.length&&attempt<4){do{date=nextDay(date);}while(!isServiceDate(date));continue;}
    // The resolved date becomes authoritative for readback and the final booking request.
    s.fingerprint=inputFingerprint({...input,preferred_date:date});
    return {...readbackFields(input,date),success:true,status:s.slots.length?'availability_found':'no_availability',available_slots:s.slots,preferred_time:[true,'true'].includes(input.completion_fallbacks)?(s.slots.includes(input.preferred_time)?input.preferred_time:s.slots[0]||'none'):undefined,readback_confirmed:false,...([true,'true'].includes(input.completion_fallbacks)?{earliest_requested:false}:{}),preferred_date:date,timezone:dealer.timezone,booking_enabled:false,verified_account_type:s.accountType,verified_vehicle:s.selectedVehicle,scheduler_selection_note:s.selectionNote||'',booking_notes:s.appointmentNotes||input.booking_notes||'',verified_services:s.selectedServices,verified_transport:s.selectedTransport,verified_pickup_address:s.pickupAddress||null,calendar_date_selected:true,searched_dates:searched,service_labels:s.selectedServices.join('|'),service_recovery_used:s.serviceResolution?.service_recovery_used||false,service_recovery_action:s.serviceResolution?.service_recovery_action||'local'};
    }
  } catch(e) {
    if(testOperation&&s&&(s.writeAttempted||s.contactSubmitted)){s.bookingStatus='unknown';return fail('booking_outcome_unknown','Do not retry submission. Verify the existing scheduler session or contact service.',{booking_status:'unknown'});}
    if(s){sessions.delete(key);await close(s);}
    // Never return connection URLs, browser errors, page contents, or caller data to logs.
    const diagnostic=e.detail||String(e.message||'').split('\n')[0].replace(/https?:\/\/\S+|wss?:\/\/\S+/g,'[URL]').split(process.env.BROWSERLESS_API_KEY||'__no_key__').join('[secret]').slice(0,240);
    return fail(e.stage==='account_selection'?'account_selection_failed':'scheduler_error','The Ford scheduler could not complete this read. No booking submission was attempted.',{failure_stage:e.stage||s?.stage||'browser_setup',failure_kind:e.kind||e.name||'connection_error',screen_headings:e.screen||[],diagnostic_detail:diagnostic});
  } finally {if(s)s.busy=false;active.delete(key);}
}

export async function shutdown(){await Promise.all([...sessions.values()].map(close));sessions.clear();}
