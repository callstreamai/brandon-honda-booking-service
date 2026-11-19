import test from 'node:test';
import assert from 'node:assert/strict';
import {checkEmail,validListenUrl,pcmWav,audible,audioOperation,transcribeClip,closeAudio} from '../src/audioRecovery.js';
const id='11111111-2222-4333-8444-555555555555';
test('malformed emails trigger proactive recovery; ordinary valid/declined emails do not',()=>{
 for(const customer_email of ['bilma@dga a.com','bilma@a@.com'])assert.equal(checkEmail({customer_email}).audio_status,'email_invalid');
 for(const customer_email of ['bilma@dga.com','none',''])assert.equal(checkEmail({customer_email}).audio_status,'not_needed');
});
test('audio can connect only to the supplied call on the official signed listen endpoint',()=>{
 assert.equal(validListenUrl('wss://api.bland.ai/ws/listen/'+id+'?token=opaque',id),true);
 for(const u of ['wss://attacker.invalid/ws/listen/'+id,'https://api.bland.ai/ws/listen/'+id,'wss://api.bland.ai/ws/listen/other','wss://user:pass@api.bland.ai/ws/listen/'+id])assert.equal(validListenUrl(u,id),false);
});
test('clear speech and chat cannot activate a listening session',async()=>{
 const env={AUDIO_FALLBACK_ENABLED:'true'};
 assert.equal((await audioOperation('start',{call_id:id,audio_field:'email',recognition_problem:false},env)).audio_status,'not_needed');
 assert.equal((await audioOperation('start',{call_id:id,audio_field:'email',recognition_problem:true,conversation_channel:'web_chat'},env)).audio_status,'voice_only');
});
test('silence cannot create an email hallucination or make an OpenAI request',async()=>{
 let calls=0;const result=await transcribeClip(Buffer.alloc(32000),'email',{},async()=>{calls++;});assert.equal(calls,0);assert.equal(result.audio_status,'no_usable_audio');
});
test('16 kHz mono PCM is wrapped as a real WAV, not mislabeled audio',()=>{const p=Buffer.alloc(32000);p.writeInt16LE(3000);const w=pcmWav(p);assert.equal(w.toString('ascii',0,4),'RIFF');assert.equal(w.readUInt32LE(24),16000);assert.equal(w.readUInt32LE(40),32000);assert.equal(w.readUInt16LE(22),1);});
test('mixed speech is only a candidate; no customer, consent or booking field can be overwritten',async()=>{
 const pcm=Buffer.alloc(32000);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(i%4?2000:-2000,i);
 let calls=0;const fake=async()=>({ok:true,json:async()=>++calls===1?{text:'Please repeat your email. B I L M A at D G A dot com.'}:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({candidate:'bilma@dga.com'})}]}]}});
 const r=await transcribeClip(pcm,'email',{OPENAI_API_KEY:'test',OPENAI_MODEL:'test'},fake);assert.equal(r.audio_candidate,'bilma@dga.com');assert.equal(r.audio_status,'candidate');assert.equal(r.customer_email,undefined);assert.equal(r.email_confirmed,undefined);assert.equal(r.readback_confirmed,undefined);assert.equal(r.audio_question.includes('Is that exactly right?'),true);
});
test('capture stops after a recovery and cannot be reused as a later answer',async()=>{
 class FakeSocket extends EventTarget{constructor(){super();setTimeout(()=>this.dispatchEvent(new Event('open')),1);}close(){this.closed=true;}}
 const env={AUDIO_FALLBACK_ENABLED:'true'};const start=await audioOperation('start',{call_id:id,audio_field:'address',recognition_problem:true,listen_url:'wss://api.bland.ai/ws/listen/'+id},env,fetch,FakeSocket);assert.equal(start.audio_status,'listening');
 assert.equal((await audioOperation('recover',{call_id:id,audio_field:'address'},env)).audio_status,'no_usable_audio');
 assert.equal((await audioOperation('recover',{call_id:id,audio_field:'address'},env)).audio_status,'capture_unavailable');closeAudio();
});
