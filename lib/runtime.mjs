import pg from 'pg';
import {attachDatabasePool,waitUntil,ipAddress} from '@vercel/functions';
import {readFileSync} from 'node:fs';
import {createGhlClient} from './ghl.mjs';
import {createStore} from './store.mjs';
import {createReceiver} from './receiver.mjs';
let receiver;
export function getReceiver(){
  if(receiver)return receiver;
  for(const key of ['DATABASE_URL','GHL_TOKEN','GHL_LOCATION_ID','AUDIT_ORIGIN','CRON_SECRET'])if(!process.env[key])throw Error('Missing '+key);
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:10000,idleTimeoutMillis:5000,query_timeout:10000});
  attachDatabasePool(pool);
  const ids=JSON.parse(readFileSync(new URL('./field-ids.json',import.meta.url),'utf8'));
  return receiver=createReceiver({store:createStore(pool),client:createGhlClient(process.env.GHL_TOKEN),locationId:process.env.GHL_LOCATION_ID,
    fieldIds:ids,origin:process.env.AUDIT_ORIGIN,secret:process.env.CRON_SECRET,schedule:waitUntil,ip:r=>ipAddress(r)||'unknown'});
}
