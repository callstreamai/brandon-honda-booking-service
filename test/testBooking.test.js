import test from 'node:test';
import assert from 'node:assert/strict';
import {isAuthorizedTestBooking,applyReviewCommunication,commitTestBooking} from '../src/testBooking.js';
test('a test booking requires the entire approved fixture, expiry and explicit readback',()=>{
 const b={call_id:'synthetic-permit',customer_name:'Casey Test',caller_phone:'2025550123',customer_email:'casey@example.com',vehicle_year:'2021',vehicle_make:'Ford',vehicle_model:'Explorer',vehicle_type:'Gas',service_labels:'Battery',transport_option:'dropoff',preferred_date:'2026-11-06',preferred_time:'7:30 a.m.',readback_confirmed:true};
 const e={AUTHORIZED_TEST_CALL_ID:b.call_id,AUTHORIZED_TEST_PHONE:b.caller_phone,AUTHORIZED_TEST_CUSTOMER_NAME:b.customer_name,AUTHORIZED_TEST_EMAIL:b.customer_email,AUTHORIZED_TEST_VEHICLE:'2021|Ford|Explorer|Gas',AUTHORIZED_TEST_SERVICE:'Battery',AUTHORIZED_TEST_TRANSPORT:'dropoff',AUTHORIZED_TEST_EXPIRES_AT:new Date(Date.now()+60000).toISOString()};
 assert.equal(isAuthorizedTestBooking(b,{}),false);assert.equal(isAuthorizedTestBooking(b,e),true);
 for(const change of [{call_id:'another-call'},{caller_phone:'2025550999'},{customer_email:'other@example.com'},{service_labels:'Oil Change'},{vehicle_model:'F150'},{transport_option:'wait'},{readback_confirmed:false}])assert.equal(isAuthorizedTestBooking({...b,...change},e),false);
 assert.equal(isAuthorizedTestBooking(b,{...e,AUTHORIZED_TEST_EXPIRES_AT:'invalid'}),false);
 assert.equal(isAuthorizedTestBooking(b,{...e,AUTHORIZED_TEST_EXPIRES_AT:'2000-01-01T00:00:00Z'}),false);
});

test('valet uses confirmed callback independently of text/email preference and checks saved phone',async()=>{
 let value='',fills=0;const phone={fill:async x=>{fills++;value=x},inputValue:async()=>value};
 const s={page:{locator:selector=>{assert.equal(selector,'#communications-phone');return phone;}}};
 const i={transport_option:'pickup',caller_phone:'+1 (410) 279-0548',caller_phone_confirmed:true,confirmation_method:'Both'};
 await applyReviewCommunication(s,i);assert.equal(value,'4102790548');assert.equal(i.confirmation_method,'Both');
 await assert.rejects(applyReviewCommunication(s,{...i,caller_phone_confirmed:false}),/confirmed contact phone/);assert.equal(fills,1);
 phone.inputValue=async()=> '4102790999';await assert.rejects(applyReviewCommunication(s,i),/phone mismatch/);
});


test('final submission waits for its own delayed response, not the calendar timer, and cannot click twice',async()=>{
 let resolveResponse,clicks=0,filter,timeout,finished=0,settled=false;
 const pending=new Promise(resolve=>{resolveResponse=resolve;});
 const page={isClosed:()=>false,waitForResponse:(fn,opts)=>{filter=fn;timeout=opts.timeout;return pending;},getByRole:(_,opts)=>opts?{count:async()=>1,isEnabled:async()=>true,click:async()=>{clicks++;}}:{count:async()=>0},locator:()=>({allTextContents:async()=>['Reservation Summary'],innerText:async()=> 'Reservation Summary',evaluateAll:async()=>[]})};
 const s={page,stage:'booking_review',reviewToken:'exact-review',finalButton:'Schedule',waitForReads:()=>{throw Error('Generic calendar timeout must not be used');}};
 const result=commitTestBooking(s,{review_token:'exact-review'}).then(r=>{settled=true;return r;});
 await new Promise(setImmediate);assert.equal(clicks,1);assert.equal(settled,false);assert.ok(timeout>31649);
 const response=(url,method='POST')=>({url:()=>url,request:()=>({method:()=>method}),finished:async()=>{finished++;}});
 assert.equal(filter(response('https://api.mss.ford.com/api/guestxpgateway/appointment/schedule')),true);
 assert.equal(filter(response('https://api.mss.ford.com/api/guestxpgateway/customer/lookup')),false);
 assert.equal(filter(response('https://example.com/api/guestxpgateway/appointment/schedule')),false);
 assert.equal(filter(response('https://api.mss.ford.com/api/guestxpgateway/appointment/schedule','GET')),false);
 resolveResponse(response('https://api.mss.ford.com/api/guestxpgateway/appointment/schedule'));await result;assert.equal(finished,1);
 const again=await commitTestBooking(s,{review_token:'exact-review'});assert.equal(again.status,'booking_write_already_attempted');assert.equal(clicks,1);
});
