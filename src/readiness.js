// Track real fetch/XHR completion in Node instead of evaluating scripts inside Ford's CSP.
// This also covers requests that start just after a date or service control changes.
export function watchReadRequests(page,{idleMs=500,timeoutMs=15000,pollMs=25}={}) {
  const pending=new Set();let activity=Date.now();
  page.on('request',request=>{if(['fetch','xhr'].includes(request.resourceType())){pending.add(request);activity=Date.now();}});
  const finished=request=>{if(pending.delete(request))activity=Date.now();};
  page.on('requestfinished',finished);page.on('requestfailed',finished);
  return async()=>{
    const started=Date.now();
    while(true){
      if(page.isClosed())throw new Error('calendar_page_closed');
      const now=Date.now();
      if(!pending.size&&now-Math.max(started,activity)>=idleMs)return;
      if(now-started>=timeoutMs)throw new Error('calendar_read_timeout');
      await new Promise(resolve=>setTimeout(resolve,pollMs));
    }
  };
}
