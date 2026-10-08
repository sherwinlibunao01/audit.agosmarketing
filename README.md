# Agos audit capture on Vercel

Branded lead audit remains custom HTML. `/api/audit-events` stores submission and PDF download-start events in managed PostgreSQL, then creates/updates GHL contacts and audit fields through scoped API integration. Standard Contact Tag workflows send team alerts without GHL premium inbound webhooks.

## Launch requirements

- Connect managed PostgreSQL to this Vercel project, exposing `DATABASE_URL`.
- Set secret environment variables `GHL_TOKEN` and `CRON_SECRET`; set `GHL_LOCATION_ID` and `AUDIT_ORIGIN`. Values stay out of repository and public HTML.
- GHL private integration needs only contacts.readonly, contacts.write and locations/customFields.readonly. Thirteen existing audit fields are mapped in `lib/field-ids.json`.
- GHL drafts: `Agos Audit | API Submission Alert` (tag added agos-audit-submitted) and `Agos Audit | API PDF Alert` (tag added agos-audit-pdf-requested). Both send internal email to designated Archie/Mark users then END. Re-entry enabled.
- Run controlled fresh-contact test before promoting branch and publishing production audit. Preview deployment needs its origin configured explicitly or production origin used for API test. Do not use real prospect information in test.

Vercel builds public/ as static output and api/ as server functions. Root legacy HTML remains available in Git history for rollback. Original marketing assets are preserved.

## Capture semantics

Receipt means saved to database, not email delivered. PDF event fires after successful PDF generation and browser download initiation; saving or opening file cannot be confirmed. Retries reuse immutable event IDs. Atomic database leases prevent overlapping workers; durable contact/tag checkpoints avoid repeating successful stages. Alert tags remain on contact until next audit removes/re-adds its event tag. Cross-system delivery cannot guarantee exactly once when a remote API times out.

Each capture processes its email's queued events for a bounded period. Daily Vercel cron sweeps retained jobs; configured once daily to fit current Hobby plan. Extended outages can delay alerts until next sweep or request. Failed permanent API errors require operator review and retry. Monitor queue counts; process health alone does not prove notification delivery.

GHL notification workflows show current contact fields; multiple rapid audits from same email may change fields before email renders. Existing scoring, task, pipeline, consent and outreach workflows remain unchanged. Audit completion/scoring/pipeline behavior must be reconciled separately before broader sales automation rollout.

## Operator endpoints

All `/api/audit-admin` actions require `Authorization: Bearer <CRON_SECRET>`.

- GET: queued/done/failed counts; no contact data returned.
- GET `?action=drain`: process eligible queued jobs and remove expired rate-limit records.
- POST `?action=retry`: requeue failed jobs after fixing configuration.

Origin checks and rate limits reduce misuse but are not authentication. Configure Vercel edge protections before production traffic. PostgreSQL stores private lead identity and answers. Restrict database access, set retention/backups, and keep preview/production environments separated where possible.

## Validation

`npm test` exercises real PostgreSQL query semantics through PGlite with fake leads and mocked GHL: durable receipts, duplicate/conflict handling, lease expiry/recovery, stale workers, event ordering, checkpoints, failures, payload limits and admin authorization. Independent frontend tests cover submission failure, PDF failure and retry identity. Live GHL API read confirmed 13 field keys/IDs; notification delivery remains a required controlled test.

Rollback through Vercel previous production deployment; return notification workflows to Draft. Preserve unsynced database events for reconciliation.
