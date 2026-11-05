import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {watchReadRequests} from '../src/readiness.js';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('a calendar request starting after the click must finish before availability can be read',async()=>{
 const page=new EventEmitter();page.isClosed=()=>false;
 const ready=watchReadRequests(page,{idleMs:25,pollMs:2,timeoutMs:1000});
 let resolved=false;const waiting=ready().then(()=>{resolved=true;});
 await delay(5);const request={resourceType:()=> 'fetch'};page.emit('request',request);
 await delay(35);assert.equal(resolved,false);
 page.emit('requestfinished',request);await waiting;assert.equal(resolved,true);
});
test('a hanging calendar request fails instead of returning stale no-availability',async()=>{
 const page=new EventEmitter();page.isClosed=()=>false;
 const ready=watchReadRequests(page,{idleMs:5,pollMs:2,timeoutMs:25});
 page.emit('request',{resourceType:()=> 'xhr'});
 await assert.rejects(ready(),/calendar_read_timeout/);
});
