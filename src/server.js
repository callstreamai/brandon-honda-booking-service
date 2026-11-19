import {searchKnowledge} from './knowledgeSearch.js';
import {audioOperation,transcribeClip,checkEmail,audioStats,closeAudio} from './audioRecovery.js';
import {valetReview} from './valet.js';
import http from 'node:http';
import {sendChangeRequest} from './changeRequest.js';
import {createChangeDraftHandler} from './changeDraft.js';
import {nextSchedulingStep} from './schedulingResume.js';
import {lookupProfile} from './profileLookup.js';
import {ingestReceipt} from './receiptIntake.js';
import {registerManagementLink,cancelOperation,cancellationConfirmed} from './cancellation.js';
import {allowedTestCaller,bookingStore,publicRecord} from './bookingStore.js';
import crypto from 'node:crypto';
import {dealer,policyDecision,normalizeTransport} from './policy.js';
import {operate,shutdown,browserStats} from './fordDriver.js';
import {recover} from './recovery.js';
import {normalizeResponseState} from './responseValues.js';
import {createAvailabilityPrefetch,searchInput} from './availabilityPrefetch.js';
import {confirmedEmailState} from './emailConfirmation.js';
const availabilityPrefetch=createAvailabilityPrefetch(operate);
const handleChangeDraft=createChangeDraftHandler();
const secret=process.env.WEBHOOK_SECRET||'';
function authorized(req){const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+secret);return !!secret&&a.length===b.length&&crypto.timingSafeEqual(a,b);}
function scrub(v){if(typeof v==='string'&&(/^\s*\{\{.*\}\}\s*$/.test(v)||v==='none'))return null;if(Array.isArray(v))return v.map(scrub);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,scrub(x)]));return v;}
const server=http.createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(req.method==='GET'&&req.url==='/health')return send(200,{status:'ok',dealer:dealer.name,dealer_code:dealer.code,browserless_configured:!!process.env.BROWSERLESS_API_KEY,booking_enabled:process.env.VOICE_TEST_BOOKING_ENABLED==='true',booking_scope:'approved_test_phone_only',durable_store_configured:!!process.env.BOOKING_STORE_PATH,recovery_configured:!!process.env.OPENAI_API_KEY&&process.env.EXTERNAL_RECOVERY_ENABLED==='true',...browserStats(),...audioStats()});
  if(!authorized(req))return send(401,{success:false,status:'unauthorized'});
  const paths={'/prepare':'prepare','/availability':'availability','/book':'book','/sessions/close':'close','/booking/review':'review','/booking/state':'inspect'};
  if(req.method!=='POST'||(!paths[req.url]&&!['/speech/open','/speech/recover','/speech/close','/speech/check-email','/speech/test','/knowledge/search','/valet/review','/appointment-change/request','/profile/lookup','/policy','/conversation/help','/appointments/lookup','/appointments/link','/receipts/gmail','/appointments/reconcile-cancel','/appointments/receipt','/cancel/review','/cancel','/cancel/state'].includes(req.url)))return send(404,{success:false,status:'not_found'});
  let raw='';try{
    for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>(req.url==='/speech/test'&&process.env.AUDIO_TEST_ENABLED==='true'?2000000:32768)){send(413,{success:false,status:'too_large'});return;}}
    const input=scrub(JSON.parse(raw));if(!input||Array.isArray(input)||typeof input!=='object')return send(400,{success:false,status:'invalid_body'});
    input.transport_option=normalizeTransport(input.transport_option);
    Object.assign(input,normalizeResponseState(input));
    Object.assign(input,searchInput(input));
    Object.assign(input,confirmedEmailState(input));
    if(input.state)input.state=normalizeResponseState(input.state);
    if(req.url==='/speech/check-email')return send(200,checkEmail(input));
    if(['/speech/open','/speech/recover','/speech/close'].includes(req.url))return send(200,await audioOperation(req.url.split('/').pop(),input));
    if(req.url==='/speech/test'){if(process.env.AUDIO_TEST_ENABLED!=='true'||!allowedTestCaller(input))return send(403,{success:false,status:'test_disabled'});return send(200,await transcribeClip(Buffer.from(String(input.pcm_base64||''),'base64'),input.audio_field));}
    if(req.url==='/knowledge/search')return send(200,await searchKnowledge(input));
    if(req.url==='/appointment-change/request')return send(200,await handleChangeDraft(input));
    if(req.url==='/receipts/gmail'){if(!allowedTestCaller(input))return send(403,{accepted:false});const store=bookingStore(),record=store.byId(input.appointment_id);if(!record||record.phone!==String(input.caller_phone).replace(/\D/g,''))return send(404,{accepted:false});return send(200,ingestReceipt(input.email,store,input.appointment_id));}
    if(req.url==='/appointments/reconcile-cancel'){if(!allowedTestCaller(input))return send(403,{success:false});const store=bookingStore(),r=store.byId(input.appointment_id);if(!r||r.phone!==String(input.caller_phone).replace(/\D/g,'')||r.cancel_status!=='unknown'||!cancellationConfirmed(input.confirmation,r.appointment_id))return send(400,{success:false,status:'confirmation_required'});store.update(r,{status:'cancelled',cancel_status:'cancelled',cancel_verification:'operator-reviewed actual provider confirmation'});return send(200,{success:true,status:'cancelled',...publicRecord(r)});}
    if(req.url==='/appointments/receipt'){if(!allowedTestCaller(input))return send(200,{success:false,status:'test_phone_required'});const r=bookingStore().byId(input.appointment_id);return send(200,r&&r.phone===String(input.caller_phone).replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'')?{success:true,record:r}:{success:false,status:'appointment_not_found'});}
    if(req.url==='/appointments/link')return send(200,registerManagementLink(input));
    if(['/cancel/review','/cancel','/cancel/state'].includes(req.url))return send(200,await cancelOperation(req.url==='/cancel'?'commit':req.url==='/cancel/state'?'state':'review',input));
    if(req.url==='/appointments/lookup'){if(!allowedTestCaller(input))return send(200,{success:false,status:'test_phone_required'});const rows=bookingStore().active(input.caller_phone);return send(200,{success:true,status:rows.length?'appointment_found':'no_appointment',appointments:rows.map(publicRecord)});}
    if(req.url==='/profile/lookup')return send(200,await lookupProfile(input));
    if(req.url==='/valet/review')return send(200,valetReview(input));
    if(req.url==='/policy'){const policy=policyDecision(input);const prefetch=availabilityPrefetch.start(input);return send(200,{success:true,policy,customer_email:input.customer_email??null,email_confirmed:input.email_confirmed??false,transport_option:input.transport_option,next_step:nextSchedulingStep(input,policy),earliest_requested:input.earliest_requested||false,prefetch_status:prefetch.status,available_slots:[],preferred_time:'none',readback_confirmed:false});}
    if(req.url==='/availability'&&[true,'true'].includes(input.anticipatory_availability))return send(200,await availabilityPrefetch.consume(input));
    if(req.url==='/sessions/close')await availabilityPrefetch.close(input.call_id);
    const result=req.url==='/conversation/help'?await recover(input):await operate(paths[req.url],input);
    send(200,result);
  }catch{send(400,{success:false,status:'invalid_request'});}
});
server.listen(Number(process.env.PORT||10000),'0.0.0.0');
process.on('SIGTERM',()=>{closeAudio();server.close();void shutdown().finally(()=>process.exit(0));});
