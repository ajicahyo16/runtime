# Phase 7: Production Runtime, Uplink, and Environment Delivery

## Objective

Make Lacify usable end-to-end by a real user:

1. Create a project.
2. Add, edit, validate, and version aggregates.
3. Deploy an isolated runtime to **development**.
4. Promote the exact validated release to **staging**.
5. Promote an approved, immutable release to **production**.

The current Vite middleware remains useful for local UI development, but it is **not** the production API. This phase replaces it with a deployed backend/runtime and makes every operation auditable.

## Product rules

- The browser never receives or persists a Cloudflare API token.
- Development, staging, and production are separate targets with separate resource names and configuration.
- A deployment is a versioned release, not a new ad-hoc build for each environment.
- Production deploys require explicit confirmation and an approval policy.
- A failed deploy never changes the active release pointer.
- API responses and logs must redact tokens, authorization headers, cookies, and encryption material.

## Target architecture

```text
React UI
  |  HTTPS + opaque HttpOnly session cookie
  v
Lacify Control API (deployed Worker / backend)
  |-- session repository (D1 or Postgres) + encrypted token envelope
  |-- project, aggregate, release, audit repositories
  |-- compiler and deployment job coordinator
  |-- Cloudflare API client
  v
User's Cloudflare account
  |-- development resources
  |-- staging resources
  `-- production resources
```

Recommended initial deployment is a dedicated Lacify Control Worker with D1. The Worker holds an encryption key as a platform secret and stores the user's Cloudflare credential as AES-256-GCM ciphertext. A database-backed queue or a durable job coordinator should run deployments that exceed a normal request lifecycle.

For a non-Cloudflare host, use the same boundaries with a Node backend, Postgres, a secret manager, and a job queue. Do not use the current local encrypted JSON file as the multi-instance production store.

## Milestone 1 — Production Control API

### Work

- Create a standalone `api/` or `control-plane/` service; move `/api/verify-uplink`, `/api/uplink-session`, project, aggregate, release, and deploy routes out of `vite.config.js`.
- Define a typed API contract shared by UI and backend. Error responses must be stable and user-safe.
- Add health and readiness endpoints; configure CORS only for the deployed UI origins.
- Run schema migrations in CI/CD and deploy the API independently from the static UI bundle.
- Remove the production dependency on `npm run dev`. `npm run build` must generate a static UI that talks to the deployed Control API.

### Acceptance criteria

- The deployed UI can connect to the deployed API after `npm run build`.
- `vite preview` is not required for API behavior.
- Invalid requests return structured 4xx errors; unexpected failures return a generic 5xx error with a request ID.
- The production API has no route that writes project data to the local filesystem.

## Milestone 2 — Identity, Uplink, and Session Security

### Work

- Add application user identity before creating Uplink records. Start with Cloudflare OAuth or another supported login provider; map user IDs to workspaces.
- Implement the Cloudflare authorization flow using OAuth Authorization Code + PKCE after client ID, redirect URI, scopes, and secret configuration are available.
- Keep manual API-token connection only as an explicitly labelled developer fallback, if it is retained. The form must send the token once over HTTPS and clear its state immediately after submission.
- Store Uplink credentials in the database as `{keyVersion, iv, tag, ciphertext}`. Keep the AES-256-GCM key only in the platform secret manager.
- Use opaque, random session IDs in `Secure; HttpOnly; SameSite=Strict` cookies. Store session metadata server-side with expiry, revocation timestamp, user ID, and workspace ID.
- Add logout, session revocation, expired-session cleanup, encryption-key rotation, rate limiting, CSRF/origin checks for state-changing requests, and audit logs.
- Never log request bodies for the Uplink endpoint or Cloudflare authorization headers.

### Acceptance criteria

- A user can refresh, sign out, and sign in again without exposing credentials in browser storage, page source, network responses, or logs.
- Two API instances read the same session correctly.
- Revoking a session immediately blocks project and deployment operations.
- Rotating the encryption key re-encrypts stored token envelopes without losing active connections.

## Milestone 3 — Project and Aggregate Authoring

### Domain model

- **Workspace**: ownership and members.
- **Project**: project slug, display name, default region/configuration, current release pointers.
- **Aggregate**: name, identifier, fields, commands, queries, lifecycle/state machine, validation rules, and aggregate version.
- **Release**: immutable compiled artifact, source revision, checksums, environment-independent manifest, creator, and status.
- **Deployment**: release ID, target environment, resource names, Cloudflare operation IDs, logs, timestamps, actor, and result.

### Work

- Replace filesystem project creation with database records and scoped authorization checks.
- Add aggregate CRUD APIs and UI flows: create aggregate, add fields, commands, queries, state transitions, edit draft, duplicate, and archive.
- Validate identifiers, field types, command input, event/state-transition integrity, duplicate names, reserved words, and breaking changes.
- Add draft autosave with optimistic concurrency (`revision` / ETag) to prevent silent overwrites.
- Show a compile preview before deployment: generated bindings, resource plan, schema/migration impact, and permission requirements.
- Version aggregate definitions and save a source snapshot when a release is created.

### Acceptance criteria

- A user can create a project and add at least one valid aggregate entirely through the UI.
- Invalid aggregate definitions cannot be released.
- A release remains reproducible after later edits to the project draft.
- Users cannot access projects or aggregates outside their workspace.

## Milestone 4 — Compiler and Release Artifacts

### Work

- Move compilation into a backend worker/job. Do not compile arbitrary user code in the browser or in the API request path.
- Define a deterministic manifest: project, aggregate versions, generated Worker modules, bindings, migrations, compatibility report, and artifact checksum.
- Store release artifacts in object storage and metadata in the database.
- Add static analysis for generated runtime code, configuration validation, resource-name collision checks, and dry-run resource plan generation.
- Produce human-readable build logs and machine-readable job status without secrets.
- Introduce compatibility categories: safe, migration required, destructive, and blocked.

### Acceptance criteria

- Compiling identical source produces an identical release checksum.
- Build failure does not create a deployable release.
- Every deployment references one immutable release ID and checksum.

## Milestone 5 — Cloudflare Provisioning and Development Deploy

### Work

- Implement a Cloudflare API client behind the Control API. Validate the account and required permissions at Uplink time and before each deploy.
- Create deterministic, environment-scoped names, for example `<project>-dev-<resource>`; never reuse staging/production resources for development.
- Implement an idempotent resource planner: inspect existing resources, calculate changes, then apply only the plan.
- Generate and deploy the runtime Worker plus configured Durable Objects, D1/KV/R2 bindings, routes, secrets, and environment variables as required by the project template.
- Add deployment-job state: `queued`, `planning`, `provisioning`, `deploying`, `verifying`, `succeeded`, `failed`, and `rolled_back`.
- Run smoke checks against the development endpoint after deploy; expose deployment logs and the runtime URL in the UI.
- Provide a clear **Deploy development** action from a selected release.

### Acceptance criteria

- A valid release can be deployed to development from the UI.
- Retrying the same deployment is idempotent.
- A failed deployment reports the failed step and leaves the last successful development release active.
- Development deployment and resource names never modify staging or production.

## Milestone 6 — Staging Promotion

### Work

- Permit staging only by selecting a release that has a successful development deployment and smoke-test record.
- Display a change summary: aggregate changes, generated-resource diff, migration plan, required permissions, and risk category.
- Require an explicit “Promote to staging” confirmation.
- Execute staging provisioning with staging-specific resource names and configuration.
- Run integration, contract, and migration checks. Store results against the deployment.
- Support rollback to the previous successful staging release.

### Acceptance criteria

- Staging deploy uses the exact immutable release that passed development; it does not recompile the current draft.
- Staging has isolated resources and configuration.
- The UI blocks promotion when development verification is absent or failed.

## Milestone 7 — Production Promotion and Operations

### Work

- Require the selected release to pass staging verification and be approved by an authorized workspace member.
- Add a production confirmation requiring the user to type the project/environment name; optionally enforce two-person approval.
- Generate a production change plan including downtime/migration risk, rollback readiness, and current-versus-target release.
- Snapshot or back up affected data before destructive migrations. Block destructive changes unless an approved migration plan exists.
- Deploy using production-only bindings and secrets. Use gradual rollout/canary where the runtime supports it.
- Verify health, key paths, and metrics before marking the release active.
- Provide rollback to the previous production release and retain immutable deployment/audit history.
- Add monitoring: deployment alerts, runtime errors, health checks, SLO/availability indicators, and audit-log export.

### Acceptance criteria

- Only an authorized, explicitly approved staging-verified release reaches production.
- Production deploys are traceable by user, timestamp, release checksum, change plan, and Cloudflare operation identifiers.
- A failed production deployment retains or restores the prior active production release.

## Delivery order

1. Milestone 1: deployable Control API.
2. Milestone 2: real identity, OAuth/manual Uplink fallback, durable encrypted sessions.
3. Milestone 3: database-backed project and aggregate authoring.
4. Milestone 4: deterministic compiler and immutable releases.
5. Milestone 5: development deployment.
6. Milestone 6: staging promotion.
7. Milestone 7: guarded production promotion, rollback, and monitoring.

Development deployment is the first user-visible deployment milestone. Staging and production promotion must not be implemented as simple environment toggles before immutable releases, permission checks, and rollback exist.

## Configuration and secrets checklist

- `LACIFY_SESSION_ENCRYPTION_KEY` (32-byte AES key; platform secret only)
- Cloudflare OAuth client ID, client secret, redirect URI, allowed scopes
- Control API public URL and approved UI origins
- Database connection/binding and migration credentials
- Artifact/object-storage binding
- Job queue or durable job coordinator binding
- Observability endpoint/DSN and alert destinations
- Environment-specific Cloudflare resource prefix and route configuration

## Out of scope for this phase

- Giving Lacify unrestricted Cloudflare account permissions by default.
- Storing Cloudflare tokens in `localStorage`, session storage, source files, build output, or plaintext database fields.
- Applying destructive database changes automatically in production.
- Treating a local Vite server or a local filesystem store as the production control plane.
