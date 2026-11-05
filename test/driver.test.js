import test from 'node:test';
import assert from 'node:assert/strict';
import {operate,browserStats} from '../src/fordDriver.js';
test('booking submission is unavailable regardless of caller-supplied approval flags',async()=>{
 const r=await operate('book',{call_id:'synthetic-write-contract',readback_confirmed:true,live_booking_enabled:true});
 assert.equal(r.success,false);assert.equal(r.status,'write_disabled');assert.equal(browserStats().active_sessions,0);
});
test('explicit cleanup is idempotent and missing browser credentials fail before connecting',async()=>{
 const old=process.env.BROWSERLESS_API_KEY;delete process.env.BROWSERLESS_API_KEY;
 try{const r=await operate('prepare',{call_id:'synthetic-missing-key'});assert.equal(r.status,'browserless_not_configured');}
 finally{if(old!==undefined)process.env.BROWSERLESS_API_KEY=old;}
 for(let i=0;i<2;i++)assert.equal((await operate('close',{call_id:'synthetic-missing-key'})).status,'session_closed');
 assert.equal(browserStats().connecting,0);assert.equal(browserStats().active_sessions,0);
});
