import http from 'node:http';
import crypto from 'node:crypto';
import {dealer,policyDecision} from './policy.js';
import {operate,shutdown,browserStats} from './fordDriver.js';
import {recover} from './recovery.js';
const secret=process.env.WEBHOOK_SECRET||'';
function authorized(req){const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+secret);return !!secret&&a.length===b.length&&crypto.timingSafeEqual(a,b);}
function scrub(v){if(typeof v==='string'&&(/^\s*\{\{.*\}\}\s*$/.test(v)||v==='none'))return null;if(Array.isArray(v))return v.map(scrub);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,scrub(x)]));return v;}
const server=http.createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(req.method==='GET'&&req.url==='/health')return send(200,{status:'ok',dealer:dealer.name,dealer_code:dealer.code,browserless_configured:!!process.env.BROWSERLESS_API_KEY,booking_enabled:false,recovery_configured:!!process.env.OPENAI_API_KEY&&process.env.EXTERNAL_RECOVERY_ENABLED==='true',...browserStats()});
  if(!authorized(req))return send(401,{success:false,status:'unauthorized'});
  const paths={'/prepare':'prepare','/availability':'availability','/book':'book','/sessions/close':'close'};
  if(req.method!=='POST'||(!paths[req.url]&&!['/policy','/conversation/help'].includes(req.url)))return send(404,{success:false,status:'not_found'});
  let raw='';try{
    for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>32768){send(413,{success:false,status:'too_large'});return;}}
    const input=scrub(JSON.parse(raw));if(!input||Array.isArray(input)||typeof input!=='object')return send(400,{success:false,status:'invalid_body'});
    const result=req.url==='/policy'?{success:true,policy:policyDecision(input)}:req.url==='/conversation/help'?await recover(input):await operate(paths[req.url],input);
    send(200,result);
  }catch{send(400,{success:false,status:'invalid_request'});}
});
server.listen(Number(process.env.PORT||10000),'0.0.0.0');
process.on('SIGTERM',()=>{server.close();void shutdown().finally(()=>process.exit(0));});
