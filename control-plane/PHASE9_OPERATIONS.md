# Phase 9 Operations and Recovery Runbook

## Ownership and service objectives

The workspace Owner assigns a named owner to each enabled service objective. Initial objectives are:

- Control Console availability: 99.9% over 30 days.
- successful immutable deployments: 99% over 30 days;
- production command success: 99.9% over 30 days;
- runtime telemetry freshness: 99% within ten minutes.

The running business Worker is independent from the Control Console. A console incident does not imply that an already-deployed runtime is unavailable. Confirm both `/health` endpoints before declaring customer impact.

## New workspace onboarding

1. Sign in with the verified Cloudflare account identity.
2. Connect Uplink with a scoped token.
3. Create or select a project.
4. Define and validate at least one Business Aggregate.
5. Record Development, Staging, and Production configuration.
6. Compile and verify an immutable release.
7. Deploy Development, inspect deep health and telemetry, then promote to Staging.
8. Create and approve a Production change request with a known rollback release.
9. Create a verified recovery bookmark.
10. Run the production-readiness review.

## Access management

- Invitations expire after seven days and their raw token is returned only when created or resent.
- Restrict invitations to a Cloudflare Account ID when the invitee is known.
- Changing a member's role revokes that member's active workspace sessions.
- Never remove or demote the final Owner. Transfer ownership first.
- Review membership after staff changes and every production incident.

## Production deployment and rollback

1. Verify the immutable checksum.
2. Confirm Development and Staging succeeded for the same release.
3. Create a change request with evidence and a last-known-healthy rollback target.
4. Approve it with a member who has `production.approve`. If separation is enabled, the requester cannot approve.
5. Confirm Production configuration has not changed since approval.
6. Resolve critical incidents. Emergency overrides require a detailed reason, expire after one hour, and are rate-limited.
7. Promote Production and wait for Worker, Durable Object, and SQLite health.
8. If verification fails, use the rollback action for the last healthy immutable release and record an incident.

## Backup and recovery

Cloudflare D1 Time Travel is the Control Plane recovery source. Record a bookmark before migrations or large data changes. The initial objectives are:

- Control Plane RPO: one minute, constrained by D1 Time Travel resolution.
- Control Plane RTO: 60 minutes.
- Runtime partition RPO: one minute where SQLite Durable Object PITR is available.
- Runtime partition RTO: 90 minutes after the partition identity and approved recovery point are confirmed.

D1 Time Travel restores in place, so do not run a Production restore as a test. Export Production, import the export into a separately named recovery D1 database, run integrity queries, and delete the recovery database only after evidence is saved.

SQLite Durable Objects support per-object PITR bookmarks for 30 days. Recovery must identify the exact partition and must never use a telemetry hash as if it were a reversible partition identifier.

Before any restore:

1. create a current bookmark to provide an undo point;
2. verify workspace, project, target, schema version, and requested timestamp;
3. use an isolated recovery target for testing;
4. compare schema version, table inventory, critical row counts, and health;
5. record the restore job and evidence;
6. require an authorized operator before an in-place Production restore.

## Incident response

1. Establish whether the Console, deployed runtime, or both are affected.
2. Acknowledge the incident and name an owner.
3. Preserve release checksum, deployment ID, health layers, configuration revision, and relevant safe telemetry.
4. Do not copy secrets, command payloads, partition keys, or business records into notes.
5. Contain compromised sessions with revoke-all; rotate Uplink, telemetry, and environment credentials independently.
6. Roll back only to a currently healthy immutable release.
7. Resolve the incident with evidence and complete a post-incident review.

## Credential rotation

- Application sessions: revoke the affected session or revoke all, then sign in again.
- Uplink: replace the scoped token from Account & Uplink. The previous encrypted connection is overwritten.
- Environment secret: rotate only the target environment; its previous value is never returned.
- Telemetry credential: redeploy only the affected environment. Deployment rotates the credential and revokes the previous one.
- Session encryption key: deploy a dual-key migration before replacing the key; never replace it without a re-encryption plan.

## Security incident and disclosure

Report suspected vulnerabilities privately to the workspace Owner through the team's established security channel. Include affected endpoint, time, reproduction steps, and non-sensitive evidence. Do not include live credentials or customer data. The Owner records and triages the report, revokes affected access, and coordinates remediation and disclosure.

## Tabletop exercises

Quarterly exercises cover:

- compromised developer session and role revocation;
- failed Production promotion followed by immutable rollback;
- accidental Control Plane data mutation followed by isolated D1 recovery validation;
- leaked environment credential rotated without affecting unrelated environments;
- Console outage while Production runtimes remain healthy.

Each exercise records participants, timestamps, decisions, gaps, owners, and due dates.

### Phase 9 launch exercise — 2026-07-23

- Owner: workspace Owner (`user_d539881bcb22df02117fcbfcb3cd364d`).
- Access scenario: temporary Admin, Developer, Operator, and Viewer sessions exercised direct API boundaries; a separate no-membership identity accepted a Viewer invitation. All temporary identities and sessions were removed after evidence capture.
- Deployment scenario: an older immutable release established the healthy Production rollback baseline, then the current release passed governed promotion and deep health.
- Recovery scenario: the pre-migration D1 export restored into `lacify-recovery-phase9-20260723`; 1 project, 1 contract, 6 releases, 8 deployment records, 1 user, and 12 migrations were present, with zero broken project-to-workspace references. The isolated database was deleted after the result was written to `restore_jobs`.
- Security scenario: cross-workspace selection, Viewer writes, Developer settings writes, Operator build writes, Admin Production approval, and final-Owner demotion were denied. CSRF and browser security-header gates passed.
- Outcome: no unresolved critical gap; the Production readiness review was approved. Repeat quarterly and after any authorization, deployment, or recovery architecture change.
