# Phase 9: Application Access and Production Readiness

## Status

**Complete.** All milestones and acceptance criteria passed in Production on 2026-07-23.

## Objective

Turn the deployed Lacify runtime and Control Console into a product that teams can safely use in day-to-day production. Workspace owners must be able to invite people, control access, configure environments, protect production changes, recover data, and understand whether the service is ready for customer traffic.

This phase builds on the immutable release workflow from Phase 7 and the operational telemetry from Phase 8. It does not replace the generated business application; it establishes the security and operational foundation required before that application is opened to real users.

## Current baseline

- [x] The Control Console is available at `https://runtime.getlacify.com`.
- [x] Cloudflare Uplink can deploy immutable releases.
- [x] Development, Staging, and Production promotion gates exist.
- [x] Production health covers the Worker, Durable Object, and SQLite layers.
- [x] Runtime telemetry, incidents, storage visibility, exports, and cost estimates are available.
- [x] Telemetry failures do not interrupt business commands.
- [x] The console has first-class application users, workspace membership, and role-based access.
- [x] Production readiness, recovery, and security controls are verified end to end.

## Product and security rules

- Application identity and Cloudflare Uplink identity are separate concerns.
- A user must never gain workspace access merely because they can authenticate with Cloudflare.
- Every workspace-scoped read and write must verify membership server-side.
- Production actions require an explicit capability; hiding a button is not authorization.
- Secrets are encrypted at rest, redacted from responses and logs, and never embedded in browser bundles.
- Invitations, sessions, API keys, and recovery tokens are expiring, revocable, and auditable.
- Development, Staging, and Production configuration must remain isolated.
- Backup and restore procedures must be tested before customer data is accepted.
- Security failures must fail closed without making an already-running business runtime unavailable.
- Empty, loading, permission-denied, expired-session, and recovery states must be explicit in the UI.

## Target access model

| Role | Workspace settings | Build and test | Deploy Dev | Deploy Staging | Approve/Deploy Production | Manage members |
| --- | --- | --- | --- | --- | --- | --- |
| Owner | Full | Yes | Yes | Yes | Yes | Yes |
| Admin | Full except ownership transfer | Yes | Yes | Yes | Configurable | Yes |
| Developer | Read | Yes | Yes | Configurable | No | No |
| Operator | Read | Read | No | Yes | Configurable | No |
| Viewer | Read | Read | No | No | No | No |

The server remains the authority for every capability. Role labels in the UI are informative, not enforcement.

## Milestone 1 — Application authentication and secure sessions

### Work

- [x] Add application-user identities independently from Cloudflare Uplink credentials.
- [x] Implement sign-in, sign-out, session refresh, expiration, and global session revocation.
- [x] Store only hashed session identifiers and encrypted provider tokens.
- [x] Add CSRF protection to state-changing browser requests.
- [x] Apply secure cookie attributes and rotate the session after authentication or privilege changes.
- [x] Add login throttling and bounded authentication failure records.
- [x] Add authenticated account and active-session pages.
- [x] Audit sign-in, sign-out, session revocation, and suspicious authentication failures.

### Acceptance criteria

- [x] An expired or revoked session cannot read workspace data.
- [x] Authentication does not automatically grant access to an existing workspace.
- [x] State-changing requests fail without valid CSRF and session context.
- [x] Session cookies and provider credentials never appear in application logs or API responses.

## Milestone 2 — Workspace membership and role-based access control

### Work

- [x] Add workspace memberships, invitations, roles, and invitation expiration.
- [x] Implement Owner, Admin, Developer, Operator, and Viewer capabilities.
- [x] Centralize server-side authorization checks for projects, releases, deployments, incidents, exports, and settings.
- [x] Add invite, accept, resend, revoke, role-change, and member-removal workflows.
- [x] Prevent removal or demotion of the last workspace Owner.
- [x] Scope project discovery so users cannot enumerate another workspace.
- [x] Add a member-management UI with clear effective permissions.
- [x] Audit every membership and role change.

### Acceptance criteria

- [x] A user cannot read or mutate another workspace by changing a URL or request body.
- [x] Viewers cannot perform writes, even through direct API requests.
- [x] Production approval is rejected unless the member has the required capability.
- [x] The final Owner cannot leave until ownership is transferred.

## Milestone 3 — Guided onboarding and environment configuration

### Work

- [x] Add a first-run checklist for workspace creation, Uplink, project setup, contract validation, and first Development deployment.
- [x] Show prerequisites and recovery actions when Uplink is missing or expired.
- [x] Add environment-scoped variables and encrypted secrets.
- [x] Validate required bindings and secrets before deployment begins.
- [x] Provide safe secret replacement without returning the previous value.
- [x] Add configuration-drift indicators between Development, Staging, and Production.
- [x] Add a readiness summary covering contracts, release verification, deployment health, telemetry, and backups.
- [x] Preserve progress when onboarding is interrupted.

### Acceptance criteria

- [x] A new Owner can reach a healthy Development deployment without undocumented steps.
- [x] Missing configuration is identified before an immutable release is promoted.
- [x] Production secrets cannot be read by members who only manage Development.
- [x] Replacing one environment secret does not redeploy or expose another environment.

## Milestone 4 — Production governance and change safety

### Work

- [x] Add configurable separation between release author, verifier, approver, and deployer.
- [x] Require a reviewed change summary and rollback target for Production.
- [x] Add deployment windows and an emergency override capability with mandatory reason.
- [x] Revalidate approval when the release checksum or Production configuration changes.
- [x] Add one-click rollback to the last healthy immutable Production release.
- [x] Run post-deployment health and telemetry verification before declaring promotion successful.
- [x] Block promotion while a critical unresolved readiness issue exists.
- [x] Audit approvals, overrides, rollbacks, and configuration changes.

### Acceptance criteria

- [x] Production cannot receive an unverified or unapproved checksum.
- [x] Approval for one checksum cannot authorize another checksum.
- [x] A failed post-deployment verification leaves an actionable rollback path.
- [x] Emergency overrides identify the actor, reason, time, and affected release.

## Milestone 5 — Backup, restore, and schema safety

### Work

- [x] Inventory Control Plane and runtime data that requires backup or reconstruction.
- [x] Add versioned backup metadata and retention policies.
- [x] Add pre-migration backup and schema compatibility checks.
- [x] Make migrations idempotent and record their checksum and execution state.
- [x] Add a restore workflow to an isolated recovery environment.
- [x] Verify restored Durable Object and SQLite data with integrity checks.
- [x] Define recovery point and recovery time objectives.
- [x] Document disaster recovery and ownership of each recovery action.

### Acceptance criteria

- [x] A tested backup can be restored without overwriting the active Production environment.
- [x] A failed migration cannot silently leave the schema version ambiguous.
- [x] Restore verification checks records, schema version, and runtime health.
- [x] Recovery procedures identify expected data loss and recovery time.

## Milestone 6 — Security hardening and abuse protection

### Work

- [x] Add security headers including CSP, HSTS, frame restrictions, and content-type protection.
- [x] Review CORS, cookie, redirect, and OAuth callback boundaries.
- [x] Add per-user, per-workspace, and sensitive-action rate limits.
- [x] Validate and bound all uploaded, imported, exported, and generated content.
- [x] Add dependency, secret, and static security scanning to the release gate.
- [x] Test authorization bypass, ID enumeration, replay, CSRF, injection, and privilege escalation cases.
- [x] Add a responsible disclosure and security incident process.
- [x] Document key, OAuth credential, session, and telemetry credential rotation.

### Acceptance criteria

- [x] High-risk authorization and injection tests pass in CI.
- [x] Cross-origin requests cannot use an authenticated session unexpectedly.
- [x] Rate limiting contains abuse without blocking health checks or existing runtimes.
- [x] No high-severity dependency or secret-scanning finding remains unresolved at release time.

## Milestone 7 — Service readiness and customer handoff

### Work

- [x] Define service-level indicators for console availability, deployment success, command success, and telemetry freshness.
- [x] Set initial service-level objectives and alert thresholds from observed data.
- [x] Add a public or workspace-visible service-status view.
- [x] Add support diagnostics that exclude secrets and business payloads.
- [x] Document onboarding, deployment, rollback, access management, backup, and incident workflows.
- [x] Add a production-readiness review with named owners and evidence links.
- [x] Run a complete owner, developer, operator, and viewer acceptance test.
- [x] Run a disaster-recovery and security-incident tabletop exercise.

### Acceptance criteria

- [x] Operators can distinguish a console outage from an already-running runtime outage.
- [x] Support diagnostics are useful without exposing credentials or customer records.
- [x] Each production-critical alert has an owner and documented response.
- [x] The production-readiness review has no unresolved critical item.

## Suggested schema additions

- `application_users`
- `application_sessions`
- `workspace_memberships`
- `workspace_invitations`
- `role_capabilities`
- `authentication_events`
- `environment_configuration`
- `environment_secrets`
- `production_change_requests`
- `deployment_overrides`
- `backup_records`
- `restore_jobs`
- `schema_migrations`
- `service_objectives`
- `readiness_reviews`

Migrations should be introduced milestone by milestone. Authorization changes must include negative tests before the corresponding UI is enabled.

## Delivery order

1. Application authentication and secure sessions.
2. Workspace membership and role-based access control.
3. Guided onboarding and environment configuration.
4. Production governance and change safety.
5. Backup, restore, and schema safety.
6. Security hardening and abuse protection.
7. Service readiness and customer handoff.

Do not open the product to external users before Milestones 1, 2, 4, 5, and 6 pass their acceptance criteria. Onboarding convenience must not bypass authorization, deployment governance, or backup requirements.

## Completion evidence — 2026-07-23

- Production migrations `0013` and `0014` applied with D1 Time Travel bookmarks and recorded SHA-256 checksums.
- Owner, Admin, Developer, Operator, and Viewer capability boundaries exercised against the deployed API. A no-membership application user accepted a seven-day Viewer invitation, could read its workspace, and received `403` for a direct settings write.
- The final-Owner guard, CSRF enforcement, cross-workspace selection denial, Production capability denial, configuration-revision approval invalidation, and security headers passed negative checks.
- A previous immutable release was promoted as a healthy rollback baseline. The current verified release then passed Development, Staging, Production, and deep Worker/Durable Object/SQLite health with that rollback target recorded.
- A real D1 export was imported into an isolated APAC recovery database. Critical record counts and workspace references were verified, evidence was recorded, and the temporary recovery database was deleted without changing Production.
- Console and runtime service status are operational. Runtime telemetry was accepted and linked to the current Production deployment, no critical incident remains open, and readiness review `readiness_18ca7971-7cb3-4ba1-b4af-1b836a4b584f` is approved.
- The release gate passes 19 tests, a production build, Wrangler validation, dependency audit with zero vulnerabilities, and static secret/security scanning.

## Definition of done

Phase 9 is complete when an invited user can authenticate, access only the authorized workspace and capabilities, safely move a verified release through the permitted environments, and operate the application using tested security, rollback, backup, restore, and incident procedures. A completed production-readiness review must show no unresolved critical issue.

## Out of scope

- Usage-based customer billing and subscription collection.
- A public marketplace for templates or generated applications.
- Enterprise SSO, SCIM, and organization-wide policy federation.
- Exact Cloudflare invoice reconciliation.
- Multi-region active-active runtime replication.
- Automatic destructive rollback without an authorized operator decision.

## Next dependency

Phase 10 introduces the personal-platform workflow: database-as-code files, deterministic SQL migrations, a local CLI, and an MCP interface for AI-assisted project development.
