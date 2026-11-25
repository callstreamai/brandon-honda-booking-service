import {hasServiceConcern} from './serviceMatch.js';
import fs from 'node:fs';
import path from 'node:path';
// The existing policy resolver owns list completion. An extractor marking the
// first service complete must not skip the opportunity to add other work.
export function createServiceCollection(file){
 const calls=new Map(file&&fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[]);
 const persist=()=>{if(!file)return;fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.tmp';const fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify([...calls]));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);};
 return function collect(input,now=Date.now()){
 if(Number(input.service_collection_contract)!==1)return {};
 for(const [k,v]of calls)if(now-v.at>3600000)calls.delete(k);
 const key=String(input.call_id||'');if(!key)return {service_complete:false};
 const prior=calls.get(key)||{complete:false,concern:null};
 const concern=hasServiceConcern(input.service_concern)?input.service_concern:null;
 const reply=String(input.last_user_message||'').trim();
 if(!concern)prior.complete=false;
 if(input.intake_field==='service_additions'&&reply&&!reply.includes('{{')){
  const noMore=/^(?:no(?:pe)?\b|nothing else\b|that(?:'s| is) (?:all|it)\b)/i.test(reply);
  if(noMore||(concern&&concern!==prior.concern))prior.complete=true;
 }
 prior.concern=concern;prior.at=now;calls.set(key,prior);persist();
 return {service_complete:prior.complete};
 };
}
let collect;
export function serviceCollection(input,now=Date.now()){
 collect??=createServiceCollection(process.env.BOOKING_STORE_PATH?path.join(path.dirname(process.env.BOOKING_STORE_PATH),'service-collection.json'):null);
 return collect(input,now);
}
