const pathway='e90854b7-0d4c-418a-81ad-59b1a027c0cc';
// Only a verified ended Lynnwood conversation releases its browser early.
// Errors, missing calls, and active conversations never count as ended.
export async function conversationEnded(id,env=process.env,fetcher=fetch){
 if(!/^[a-f0-9-]{36}$/i.test(id)||!env.BLAND_LIVE_LISTEN_API_KEY)return false;
 const headers={authorization:env.BLAND_LIVE_LISTEN_API_KEY};
 try{
  let r=await fetcher('https://api.bland.ai/v1/calls/'+id,{headers,signal:AbortSignal.timeout(2500)});
  if(r.status===404)r=await fetcher('https://api.bland.ai/v1/pathway/chat/'+id,{headers,signal:AbortSignal.timeout(2500)});
  if(!r.ok)return false;let d=await r.json();while(d?.data)d=d.data;
  return d?.pathway_id===pathway&&d.completed===true;
 }catch{return false;}
}
