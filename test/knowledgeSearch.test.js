import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchKnowledge} from '../src/knowledgeSearch.js';
const env={OPENAI_API_KEY:'test'};
const body=(url='https://www.ford.com/support/technology/')=>({status:'completed',output:[{type:'web_search_call',status:'completed'},{type:'message',content:[{type:'output_text',text:'Ford explains the feature. citeturn0search0',annotations:[{type:'url_citation',url,title:'Ford support'}]}]}]});
test('public search uses restricted tool, no private state, caches answer',async()=>{
 let n=0;const fetcher=async(url,opt)=>{n++;const p=JSON.parse(opt.body);assert.equal(p.store,false);assert.equal(p.tools[0].type,'web_search');assert.ok(p.tools[0].filters.allowed_domains.includes('ford.com'));assert.equal(p.tools[0].search_context_size,'low');assert.ok(!opt.body.includes('secret-customer'));return {ok:true,json:async()=>body()};};
 const input={call_id:'cache-test',question:'What is Ford SYNC?',state:{customer_name:'secret-customer'}};
 const r=await searchKnowledge(input,{env,fetcher});assert.equal(r.search_status,'answered');assert.equal(r.search_answer,'Ford explains the feature.');assert.equal(r.recovered_state,undefined);assert.equal((await searchKnowledge(input,{env,fetcher})).search_cached,true);assert.equal(n,1);
});
test('private data and appointment/policy requests do not call search',async()=>{
 const fetcher=()=>{throw Error('must not call');};
 for(const question of ['Find my appointment','What are loaner prices?','Contact me at 4102790548','My email is test@example.com','Check VIN 1FTFW1E50NFA12345'])assert.notEqual((await searchKnowledge({call_id:'blocked',question},{env,fetcher})).search_status,'answered');
});
test('rejects uncited, unsearched, incomplete and unapproved-domain answers',async()=>{
 const samples=[body('https://ford.com.attacker.example/'),{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'invented'}]}]},{status:'incomplete',output:[]}];
 for(let i=0;i<samples.length;i++){const r=await searchKnowledge({call_id:'bad-'+i,question:'Ford feature '+i},{env,fetcher:async()=>({ok:true,json:async()=>samples[i]})});assert.equal(r.search_status,'unverified');assert.deepEqual(r.search_sources,[]);}
});
test('deadline returns even if upstream ignores abort; stale results never cached',async()=>{
 const r=await searchKnowledge({call_id:'timeout',question:'Ford timeout feature'},{env,timeoutMs:15,fetcher:()=>new Promise(()=>{})});assert.equal(r.search_status,'timeout');assert.ok(r.search_elapsed_ms<500);
});
test('failed requests are bounded per call and never automatically retry',async()=>{
 let n=0;const opts={env,fetcher:async()=>{n++;return {ok:false};}};
 for(let i=0;i<2;i++)assert.equal((await searchKnowledge({call_id:'limit',question:'Ford limit '+i},opts)).search_status,'unavailable');
 assert.equal((await searchKnowledge({call_id:'limit',question:'Ford limit last'},opts)).search_status,'search_limit');assert.equal(n,2);
});
