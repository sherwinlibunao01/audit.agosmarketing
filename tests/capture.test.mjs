import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createStore,SCHEMA} from '../lib/store.mjs';
import {createReceiver} from '../lib/receiver.mjs';
const origin='https://audit.agosmarketing.com';
const event=(kind='audit_submitted')=>({event:kind,audit_id:'11111111-1111-4111-8111-111111111111',event_id:'11111111-1111-4111-8111-111111111111:'+kind,full_name:'Fake Lead',email:'fake@example.invalid',business_name:'Test Only',overall_score:50});
async function setup(t,api=async()=>({contact:{id:'fake-contact'}})){
 const db=new PGlite();await db.exec(SCHEMA);let now=1000;
 const store=createStore({query:(sql,args)=>sql===SCHEMA?Promise.resolve({rows:[]}):db.query(sql,args)},()=>now),work=[];
 const receiver=createReceiver({store,client:api,locationId:'test',fieldIds:{},origin,secret:'admin',schedule:p=>work.push(p),clock:()=>now,sleep:async ms=>{now+=ms;}});
 const request=(body,headers={})=>new Request(origin+'/api/audit-events',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 t.after(async()=>{await Promise.all(work);await db.close();});return {db,store,receiver,request,tick:n=>now+=n};
}
test('durable receipt, duplicate suppression and conflicting identity',async t=>{
 const r=await setup(t);assert.equal((await r.store.capture(event())).status,202);assert.equal((await r.store.capture(event())).status,200);
 assert.equal((await r.db.query('SELECT count(*)::int n FROM agos_audit_events')).rows[0].n,1);assert.equal((await r.store.capture({...event(),overall_score:10})).status,409);
});
test('PDF needs prior matching submission',async t=>{
 const r=await setup(t);assert.equal((await r.store.capture(event('pdf_download_initiated'))).status,409);await r.store.capture(event());
 assert.equal((await r.store.capture({...event('pdf_download_initiated'),email:'other@example.invalid'})).status,409);assert.equal((await r.store.capture(event('pdf_download_initiated'))).status,202);
});
test('atomic leases exclude overlapping deliveries and recover terminated invocations',async t=>{
 const r=await setup(t);await r.store.capture(event());const first=await r.store.claim();assert.ok(first);assert.equal(await r.store.claim(),undefined);
 r.tick(330001);const next=await r.store.claim();assert.ok(next);assert.notEqual(next.lease,first.lease);await assert.rejects(r.store.checkpoint(first,'done'),/lease lost/);await r.store.checkpoint(next,'done');
});
test('failed delivery blocks later same-email event until operator retry',async t=>{
 const r=await setup(t);await r.store.capture(event());await r.store.capture(event('pdf_download_initiated'));const first=await r.store.claim();const e=Error('unauthorized');e.status=401;await r.store.fail(first,e);
 assert.equal(await r.store.claim(),undefined);assert.equal(await r.store.pending(first.email),0);await r.store.retry();const next=await r.store.claim();assert.equal(next.id,first.id);await r.store.checkpoint(next,'done');assert.equal((await r.store.claim()).event,'pdf_download_initiated');
});
test('checkpointed contact and tag reset survive retry',async t=>{
 const calls=[];const r=await setup(t,async(path,method)=>{calls.push(method);return {contact:{id:'fake-contact'}};});await r.store.capture(event());const first=await r.store.claim();
 await r.store.checkpoint(first,'contact','fake-contact');await r.store.checkpoint(first,'reset');await r.store.fail(first,Error('timeout'));r.tick(20001);await r.receiver.drain();assert.deepEqual(calls,['POST']);assert.deepEqual(await r.store.counts(),[{status:'done',count:1}]);
});
test('capture rejects wrong origin, invalid details and oversized payload; storage failure not acknowledged',async t=>{
 const r=await setup(t);assert.equal((await r.receiver.capture(r.request(event(),{Origin:'https://other.invalid'}))).status,403);assert.equal((await r.receiver.capture(r.request({...event(),email:'bad'}))).status,400);
 assert.equal((await r.receiver.capture(r.request({...event(),answers_summary:'x'.repeat(49000)}))).status,413);
 const broken=createReceiver({store:{rateLimit:async()=>{throw Error('DB unavailable');}},origin});const response=await broken.capture(r.request(event()));assert.equal(response.status,503);assert.equal((await response.json()).accepted,undefined);
});
test('rate limiting survives separate requests and recovers next minute',async t=>{
 const r=await setup(t);for(let i=0;i<60;i++)assert.equal(await r.store.rateLimit('fake-ip'),true);assert.equal(await r.store.rateLimit('fake-ip'),false);r.tick(60001);assert.equal(await r.store.rateLimit('fake-ip'),true);
});
test('admin endpoints require server-only secret',async t=>{
 const r=await setup(t);assert.equal((await r.receiver.admin(new Request(origin+'/api/audit-admin'))).status,401);assert.equal((await r.receiver.admin(new Request(origin+'/api/audit-admin',{headers:{Authorization:'Bearer admin'}}))).status,200);
});
