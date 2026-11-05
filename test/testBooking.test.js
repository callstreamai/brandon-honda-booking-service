import test from 'node:test';
import assert from 'node:assert/strict';
import {isAuthorizedTestBooking} from '../src/testBooking.js';
test('a test booking requires the entire approved fixture, expiry and explicit readback',()=>{
 const b={call_id:'synthetic-permit',customer_name:'Casey Test',caller_phone:'2025550123',customer_email:'casey@example.com',vehicle_year:'2021',vehicle_make:'Ford',vehicle_model:'Explorer',vehicle_type:'Gas',service_labels:'Battery',transport_option:'dropoff',preferred_date:'2026-11-06',preferred_time:'7:30 a.m.',readback_confirmed:true};
 const e={AUTHORIZED_TEST_CALL_ID:b.call_id,AUTHORIZED_TEST_PHONE:b.caller_phone,AUTHORIZED_TEST_CUSTOMER_NAME:b.customer_name,AUTHORIZED_TEST_EMAIL:b.customer_email,AUTHORIZED_TEST_VEHICLE:'2021|Ford|Explorer|Gas',AUTHORIZED_TEST_SERVICE:'Battery',AUTHORIZED_TEST_TRANSPORT:'dropoff',AUTHORIZED_TEST_EXPIRES_AT:new Date(Date.now()+60000).toISOString()};
 assert.equal(isAuthorizedTestBooking(b,{}),false);assert.equal(isAuthorizedTestBooking(b,e),true);
 for(const change of [{call_id:'another-call'},{caller_phone:'2025550999'},{customer_email:'other@example.com'},{service_labels:'Oil Change'},{vehicle_model:'F150'},{transport_option:'wait'},{readback_confirmed:false}])assert.equal(isAuthorizedTestBooking({...b,...change},e),false);
 assert.equal(isAuthorizedTestBooking(b,{...e,AUTHORIZED_TEST_EXPIRES_AT:'invalid'}),false);
 assert.equal(isAuthorizedTestBooking(b,{...e,AUTHORIZED_TEST_EXPIRES_AT:'2000-01-01T00:00:00Z'}),false);
});
