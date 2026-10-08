export const TAGS = {audit_submitted:'agos-audit-submitted',pdf_download_initiated:'agos-audit-pdf-requested'};
export const FIELD_MAP = {
  business_name:'contact.audit_business_name',overall_score:'contact.audit_score',
  overall_grade:'contact.audit_overall_grade',overall_tier:'contact.audit_tier',
  monthly_lead_volume:'contact.audit_monthly_lead_volume',leads_at_risk:'contact.audit_leads_at_risk',
  category_summary:'contact.audit_category_summary',answers_summary:'contact.audit_answers',
  grade_speed:'contact.audit_speed_grade',grade_missed:'contact.audit_missed_call_grade',
  grade_noshow:'contact.audit_noshow_grade',grade_followup:'contact.audit_followup_grade',
  grade_afterhours:'contact.audit_afterhours_grade'
};
export function validate(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Invalid event');
  if (!TAGS[input.event] || !/^[a-f0-9-]{36}$/i.test(input.audit_id || '') || input.event_id !== `${input.audit_id}:${input.event}`) throw new Error('Invalid event identity');
  for (const key of ['full_name','email','business_name']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 250) throw new Error('Missing lead details');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new Error('Invalid email');
  if (!Number.isFinite(input.overall_score) || input.overall_score < 0 || input.overall_score > 100) throw new Error('Invalid score');
  const event = {};
  const allowed = ['audit_id','event_id','event','full_name','first_name','last_name','email','business_name','overall_score','overall_grade','overall_tier','monthly_lead_volume','leads_at_risk','submitted_at','downloaded_at','page_url','category_summary','answers_summary'];
  for (const category of ['speed','missed','noshow','followup','afterhours']) allowed.push(`grade_${category}`,`score_${category}`);
  for (let i=1;i<=7;i++) allowed.push(`q${i}_question`,`q${i}_answer`);
  for (const key of allowed) {
    if (input[key] === undefined) continue;
    if (typeof input[key] === 'string' && input[key].length <= 12000) event[key] = input[key];
    else if (typeof input[key] === 'number' && Number.isFinite(input[key])) event[key] = input[key];
    else throw new Error('Invalid field value');
  }
  event.email = event.email.trim().toLowerCase();
  return event;
}
export function contactBody(event, locationId, fieldIds) {
  const parts = event.full_name.trim().split(/\s+/);
  return {locationId,firstName:parts[0],lastName:parts.slice(1).join(' '),
    email:event.email,companyName:event.business_name,source:'Agos Lead Leak Audit',
    customFields:Object.entries(FIELD_MAP).filter(([key])=>event[key] !== undefined).map(([key,fieldKey])=>{
      if (!fieldIds[fieldKey]) throw new Error(`Unconfigured custom field: ${fieldKey}`);
      return {id:fieldIds[fieldKey],fieldValue:event[key]};
    })};
}
export function createGhlClient(token, fetcher=fetch) {
  return async (path,method,body) => {
    const response = await fetcher(`https://services.leadconnectorhq.com${path}`,{
      method,headers:{Authorization:`Bearer ${token}`,Version:'2021-07-28','Content-Type':'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      const error = new Error(`GHL HTTP ${response.status}`);
      error.status = response.status;
      throw error; // Never log response payloads or credentials.
    }
    return response.json();
  };
}
export async function deliver(job, client, locationId, fieldIds, checkpoint) {
  const event = JSON.parse(job.payload);
  if (!job.contact_id) {
    const result = await client('/contacts/upsert','POST',contactBody(event,locationId,fieldIds));
    if (!result.contact?.id) throw new Error('GHL contact ID missing');
    job.contact_id = result.contact.id;
    await checkpoint('contact',job.contact_id);
  }
  const path = `/contacts/${encodeURIComponent(job.contact_id)}/tags`;
  if (!job.tag_reset) {
    await client(path,'DELETE',{tags:[TAGS[event.event]]});
    job.tag_reset = 1;
    await checkpoint('reset');
  }
  // Keep event tag on contact. A new audit resets it once; retries only add it.
  await client(path,'POST',{tags:[TAGS[event.event]]});
  await checkpoint('done');
}
