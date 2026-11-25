import {hasServiceConcern} from './serviceMatch.js';
const calls=new Map();
// The existing policy resolver owns list completion. An extractor marking the
// first service complete must not skip the opportunity to add other work.
export function serviceCollection(input,now=Date.now()){
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
 prior.concern=concern;prior.at=now;calls.set(key,prior);
 return {service_complete:prior.complete};
}
