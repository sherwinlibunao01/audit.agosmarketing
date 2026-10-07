import {timingSafeEqual} from 'node:crypto';
import {validate,deliver} from './ghl.mjs';
const response=(status,body,headers={})=>new Response(status===204?null:JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
export function createReceiver({store,client,locationId,fieldIds,origin,secret,schedule=()=>{},ip=()=> 'unknown',clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  async function drain(email=null){
    const stop=clock()+180000;let attempts=0;
    while(clock()<stop&&attempts<4){
      const job=await store.claim(email);
      if(!job){
        if(email&&await store.pending(email)){await sleep(1000);continue;}
        break;
      }
      attempts++;
      try {await deliver(job,client,locationId,fieldIds,(stage,id)=>store.checkpoint(job,stage,id));}
      catch(error){await store.fail(job,error);console.error('Audit sync pending',job.id,error.status||'network/configuration');}
    }
  }
  function authorized(request){
    const supplied=request.headers.get('authorization');if(!secret||!supplied)return false;
    const a=Buffer.from(supplied),b=Buffer.from('Bearer '+secret);return a.length===b.length&&timingSafeEqual(a,b);
  }
  return {
    drain,
    async capture(request){
      const headers={'Access-Control-Allow-Origin':origin,Vary:'Origin'};
      if(request.headers.get('origin')!==origin)return response(403,{error:'Origin rejected'});
      if(request.method==='OPTIONS')return response(204,null,{...headers,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type'});
      if(request.method!=='POST')return response(405,{error:'Method rejected'},headers);
      if(!request.headers.get('content-type')?.startsWith('application/json'))return response(415,{error:'JSON required'},headers);
      try {
        if(!await store.rateLimit(ip(request)))return response(429,{error:'Please retry later'},headers);
        const reader=request.body?.getReader();if(!reader)return response(400,{error:'Invalid audit event'},headers);
        const chunks=[];let size=0;
        for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>48000){await reader.cancel();return response(413,{error:'Event too large'},headers);}chunks.push(value);}
        let event;try{event=validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{return response(400,{error:'Invalid audit event'},headers);}
        const result=await store.capture(event),{status,...body}=result;
        if(result.accepted)schedule(drain(event.email).catch(()=>console.error('Audit queue needs review')));
        return response(status,body,headers);
      }catch{return response(503,{error:'Capture unavailable'},headers);}
    },
    async admin(request){
      if(!authorized(request))return response(401,{error:'Unauthorized'});
      try{
        const action=new URL(request.url).searchParams.get('action');
        if(request.method==='GET'&&action==='drain'){await drain();await store.cleanupLimits();return response(200,{counts:await store.counts()});}
        if(request.method==='GET'&&!action)return response(200,{counts:await store.counts()});
        if(request.method==='POST'&&action==='retry'){await store.retry();schedule(drain().catch(()=>console.error('Audit queue needs review')));return response(202,{accepted:true});}
        return response(405,{error:'Method rejected'});
      }catch{return response(503,{error:'Queue unavailable'});}
    }
  };
}
