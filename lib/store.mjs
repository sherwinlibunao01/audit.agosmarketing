import {createHash,randomUUID} from 'node:crypto';
export const SCHEMA=`
CREATE TABLE IF NOT EXISTS agos_audit_events (
  seq BIGSERIAL PRIMARY KEY,id TEXT UNIQUE NOT NULL,audit_id TEXT NOT NULL,event TEXT NOT NULL,
  email TEXT NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',
  contact_id TEXT,tag_reset INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt BIGINT NOT NULL DEFAULT 0,lease TEXT,lease_until BIGINT NOT NULL DEFAULT 0,
  created BIGINT NOT NULL,error TEXT);
CREATE INDEX IF NOT EXISTS agos_audit_queue ON agos_audit_events(status,next_attempt);
CREATE INDEX IF NOT EXISTS agos_audit_email ON agos_audit_events(email,seq);
CREATE INDEX IF NOT EXISTS agos_audit_identity ON agos_audit_events(audit_id,event);
CREATE TABLE IF NOT EXISTS agos_audit_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_ms BIGINT NOT NULL);
`;
export function createStore(db,clock=Date.now){
  let initialized;
  const ensure=()=>initialized ||= db.query(SCHEMA).catch(e=>{initialized=null;throw e;});
  return {
    ensure,
    async rateLimit(ip){
      await ensure();const now=clock(),key=createHash('sha256').update(ip).digest('hex');
      const {rows}=await db.query(`INSERT INTO agos_audit_limits(key,count,until_ms) VALUES($1,1,$2)
        ON CONFLICT(key) DO UPDATE SET count=CASE WHEN agos_audit_limits.until_ms<$3 THEN 1 ELSE agos_audit_limits.count+1 END,
        until_ms=CASE WHEN agos_audit_limits.until_ms<$3 THEN $2 ELSE agos_audit_limits.until_ms END RETURNING count`,[key,now+60000,now]);
      return rows[0].count<=60;
    },
    async capture(event){
      await ensure();const payload=JSON.stringify(event),hash=createHash('sha256').update(payload).digest('hex');
      if(event.event==='pdf_download_initiated'){
        const {rows}=await db.query("SELECT email FROM agos_audit_events WHERE audit_id=$1 AND event='audit_submitted'",[event.audit_id]);
        if(!rows[0]||rows[0].email!==event.email)return {status:409,error:'Submit audit first'};
      }
      const saved=await db.query(`INSERT INTO agos_audit_events(id,audit_id,event,email,payload,hash,created)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`,[event.event_id,event.audit_id,event.event,event.email,payload,hash,clock()]);
      if(saved.rows.length)return {status:202,accepted:true};
      const existing=await db.query('SELECT hash FROM agos_audit_events WHERE id=$1',[event.event_id]);
      return existing.rows[0]?.hash===hash?{status:200,accepted:true,duplicate:true}:{status:409,error:'Event identity conflict'};
    },
    async claim(email=null){
      await ensure();const now=clock(),lease=randomUUID();
      // Atomic lease prevents parallel Vercel invocations delivering the same event.
      const {rows}=await db.query(`WITH candidate AS (
        SELECT e.seq FROM agos_audit_events e WHERE e.status='queued' AND e.next_attempt<=$1 AND e.lease_until<$1
        AND ($2::text IS NULL OR e.email=$2)
        AND NOT EXISTS(SELECT 1 FROM agos_audit_events older WHERE older.email=e.email AND older.seq<e.seq AND older.status!='done')
        ORDER BY e.seq FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE agos_audit_events e SET lease=$3,lease_until=$4 FROM candidate c WHERE e.seq=c.seq RETURNING e.*`,[now,email,lease,now+330000]);
      return rows[0];
    },
    async checkpoint(job,stage,id){
      let sql,args;
      if(stage==='contact'){sql='contact_id=$3';args=[job.id,job.lease,id];}
      if(stage==='reset'){sql='tag_reset=1';args=[job.id,job.lease];}
      if(stage==='done'){sql="status='done',error=NULL,lease=NULL,lease_until=0";args=[job.id,job.lease];}
      const result=await db.query(`UPDATE agos_audit_events SET ${sql} WHERE id=$1 AND lease=$2 RETURNING id`,args);
      if(!result.rows.length)throw Error('Delivery lease lost');
    },
    async fail(job,error){
      const attempts=job.attempts+1,permanent=[400,401,403,404,422].includes(error.status);
      await db.query(`UPDATE agos_audit_events SET status=$3,attempts=$4,next_attempt=$5,error=$6,lease=NULL,lease_until=0
        WHERE id=$1 AND lease=$2`,[job.id,job.lease,permanent||attempts>=20?'failed':'queued',attempts,
        clock()+Math.min(3600000,10000*2**Math.min(attempts,9)),`GHL ${error.status||'network/configuration'}`]);
    },
    async pending(email){
      const {rows}=await db.query(`SELECT count(*)::int count FROM agos_audit_events e WHERE status='queued' AND email=$1
        AND NOT EXISTS(SELECT 1 FROM agos_audit_events older WHERE older.email=e.email AND older.seq<e.seq AND older.status='failed')`,[email]);
      return rows[0].count;
    },
    async counts(){await ensure();return (await db.query('SELECT status,count(*)::int count FROM agos_audit_events GROUP BY status')).rows;},
    async retry(){await ensure();await db.query("UPDATE agos_audit_events SET status='queued',attempts=0,next_attempt=0 WHERE status='failed'");},
    async cleanupLimits(){await db.query('DELETE FROM agos_audit_limits WHERE until_ms<$1',[clock()-86400000]);}
  };
}
