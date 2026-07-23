# Phase 10: Database-as-Code, CLI, and MCP

## Status

**Complete — all seven milestones accepted. Production promotion remains an explicit governed user action.**

## Objective

Turn Lacify into a personal AI-native database/runtime platform that can be used while building ordinary software projects.

An AI coding agent must be able to inspect a Lacify project through MCP, create version-controlled runtime and SQL migration files in the user's repository, validate the proposed change, and present a deterministic plan. The user remains in control of applying changes.

Lacify is not a PostgreSQL clone. The developer experience is database-as-code, while the deployed result remains:

```text
stateless Worker
  → Business Aggregate Durable Object
    → private SQLite state
      → request-response business lifecycle
```

## Target workflow

```text
AI connects to Lacify MCP
  → reads project, Actor schema, commands, migrations, and environment state
  → creates or edits repository files
  → runs `lacify validate`
  → runs `lacify plan --env development`
  → user reviews the file diff and plan
  → user runs or approves `lacify apply --env development`
  → Lacify compiles an immutable release
  → user promotes the verified release through existing governance
```

## Canonical repository layout

```text
lacify.runtime.yaml
actors/
  outlet/
    actor.yaml
    migrations/
      0001_initial.sql
      0002_add_refunds.sql
  warehouse/
    actor.yaml
    migrations/
      0001_initial.sql
.lacify/
  lock.json
```

### `lacify.runtime.yaml`

Defines project-level runtime identity and Actor membership:

```yaml
version: lacify.dev/v1
project: lacify-pos
runtime: request-response
actors:
  - ./actors/outlet/actor.yaml
  - ./actors/warehouse/actor.yaml
```

### `actor.yaml`

Defines the Business Aggregate boundary, partition key, commands, and lifecycle policy:

```yaml
version: lacify.dev/actor/v1
name: Outlet
partitionBy: outletId
storage: sqlite
commands:
  - OpenShift
  - PlaceOrder
  - CapturePayment
  - AdjustStock
  - CloseShift
```

### SQL migrations

Use a bounded SQLite dialect for the private database owned by each Actor:

```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  total INTEGER NOT NULL CHECK (total >= 0),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX orders_by_outlet_and_status
ON orders(outlet_id, status);
```

SQL defines storage. Actor YAML defines ownership, routing, commands, and runtime behavior. Lacify must not infer a transactional boundary from table names alone.

## Product and safety rules

- Repository files are the authoring source of truth for CLI-managed projects.
- The Control Plane remains the deployment, audit, environment, and recovery authority.
- AI may create files and request validation without Production credentials.
- `validate` and `plan` are read-only.
- Development apply requires explicit user approval.
- Staging and Production continue through immutable release governance from Phases 7–9.
- Destructive SQL is rejected by default and requires an explicit migration annotation plus confirmation.
- Applied migration IDs and checksums are immutable.
- An edited applied migration is an error; the user must create a new migration.
- Migration execution is per Actor schema and must never cross another partition or workspace.
- Secrets are referenced by name and environment; values never appear in repository files, MCP resources, plans, or generated artifacts.
- MCP tools must return bounded metadata and never expose business rows by default.

## Milestone 1 — Canonical file specification

### Work

- [x] Define and version the `lacify.runtime.yaml` schema.
- [x] Define and version the `actor.yaml` schema.
- [x] Define the supported SQLite migration dialect.
- [x] Define command, state-machine, summary-table, and secret-reference syntax.
- [x] Define stable normalization rules used for checksums.
- [x] Add JSON Schema files and human-readable reference documentation.
- [x] Add fixtures for POS, inventory, booking, and approval-workflow projects.

### Acceptance criteria

- [x] Equivalent normalized files produce the same project fingerprint.
- [x] Unknown fields, duplicate Actor names, invalid partition keys, and unsupported SQL fail with file and line context.
- [x] A file cannot declare WebSocket or long-lived runtime behavior under Runtime v1.
- [x] No environment secret value can be represented in the canonical schema.

### Completion evidence

- Runtime and Actor JSON Schemas live in `runtime-spec/schemas/`.
- The executable loader and validator live in `runtime-spec/src/index.mjs`.
- The reference documentation lives in `runtime-spec/REFERENCE.md`.
- POS, inventory, booking, and approval fixtures load successfully.
- Thirteen Milestone 1 tests cover deterministic fingerprinting, YAML safety, semantic references, SQL restrictions, missing files, line diagnostics, duplicate Actors, and all fixtures.

## Milestone 2 — Migration engine and schema registry

### Work

- [x] Parse migrations into a deterministic ordered plan.
- [x] Store migration ID, Actor, checksum, status, timing, and release identity.
- [x] Detect edited, missing, duplicated, and out-of-order migrations.
- [x] Classify operations as additive, data-changing, destructive, or unsupported.
- [x] Add preflight schema compatibility checks.
- [x] Create a pre-apply recovery bookmark and record it with the migration.
- [x] Apply migrations transactionally where SQLite supports the operation.
- [x] Preserve an unambiguous failed state and recovery instructions.
- [x] Introspect deployed Actor schemas without reading business rows.

### Acceptance criteria

- [x] Reapplying a completed migration is a safe no-op.
- [x] Modifying an applied migration is rejected.
- [x] A failed migration cannot be reported as applied.
- [x] A destructive operation cannot run through a default apply.
- [x] The deployed schema can be compared with repository state.

### Completion evidence

- The deterministic planner, SQLite migration ledger, transactional executor, recovery bookmark handling, and metadata-only schema introspector live in `runtime-spec/src/migration-engine.mjs`.
- The ledger records Actor, migration ID, checksum, state, timing, immutable release identity, recovery bookmark, and bounded failure detail.
- Six migration-engine tests cover classification, repeat apply, tampering, missing and out-of-order files, destructive blocking, transactional failure, recovery evidence, and business-row isolation.

## Milestone 3 — Local `lacify` CLI

### Work

- [x] Package an installable `lacify` CLI.
- [x] Add `lacify init`.
- [x] Add `lacify pull` to materialize the current Control Plane contract as files.
- [x] Add `lacify validate`.
- [x] Add `lacify plan --env <environment>`.
- [x] Add `lacify apply --env development`.
- [x] Add `lacify status`, `lacify migrations`, and `lacify health`.
- [x] Add structured JSON output for automation and readable terminal output for humans.
- [x] Add device/browser authentication without storing a raw Uplink token in the project.

### Acceptance criteria

- [x] A new repository can initialize, validate, plan, and apply a Development Actor without opening the console.
- [x] `plan` performs no mutation.
- [x] CLI errors identify the file, Actor, environment, and safe recovery action.
- [x] Authentication material is stored using an OS-appropriate protected mechanism and is revocable.

### Completion evidence

- `bin/lacify.mjs` exposes login, logout, init, pull, validate, plan, apply, status, migrations, health, and generate commands.
- Browser/device authorization is implemented in the Control API and console; the resulting opaque token is stored in macOS Keychain or Linux Secret Service, never in the repository.
- Remote Development apply uploads canonical Actor contracts and authored SQL migrations, binds the project fingerprint, compiles and verifies an immutable release, then starts the governed Development deployment.
- CLI tests cover the complete local workflow, read-only planning, explicit approval, drift, Production blocking, protected logout, and human/JSON output.

## Milestone 4 — File synchronization and drift

### Work

- [x] Add project fingerprint and base revision to `.lacify/lock.json`.
- [x] Detect repository-versus-Control-Plane drift before apply.
- [x] Prevent silent last-write-wins behavior.
- [x] Add `pull`, three-way comparison, and conflict guidance.
- [x] Display file-managed project status in the Control Console.
- [x] Preserve compatibility with projects originally authored in the visual designer.

### Acceptance criteria

- [x] Concurrent visual and file changes produce an explicit conflict.
- [x] Pulling does not overwrite uncommitted repository work.
- [x] A visual project can be exported to canonical files and revalidated without semantic change.
- [x] Environment drift remains separate from authoring-file drift.

## Milestone 5 — Lacify MCP server

### Resources

- [x] Projects visible to the authenticated personal account.
- [x] Actor definitions and schema fingerprints.
- [x] Migration history and current schema version.
- [x] Environment configuration names and secret-name inventory.
- [x] Release, deployment, health, and readiness summaries.
- [x] File-format and migration documentation.

### Tools

- [x] `list_projects`
- [x] `get_project`
- [x] `get_actor_schema`
- [x] `get_migration_history`
- [x] `validate_project_files`
- [x] `plan_migration`
- [x] `get_environment_drift`
- [x] `get_runtime_health`
- [x] `apply_development_plan` with explicit approval

### Security rules

- MCP authentication maps to an application user and workspace membership.
- Read tools enforce workspace scope server-side.
- Mutation tools use the existing capability matrix, CSRF-equivalent request binding, rate limits, and audits.
- Raw environment secrets, Uplink credentials, session identifiers, business payloads, and reversible partition identifiers are never MCP resources.
- Production deployment, rollback, recovery, and destructive migration are not implicit MCP actions.

### Acceptance criteria

- [x] An AI agent can discover a project and understand its Actors without receiving business records.
- [x] The agent can create local files, validate them, and show a deterministic plan.
- [x] A Viewer cannot use MCP to mutate a project.
- [x] A plan cannot be replayed after its source fingerprint or environment revision changes.
- [x] Every approved MCP mutation records actor, user, project, files fingerprint, and result.

## Milestone 6 — AI authoring workflow

### Work

- [x] Publish concise agent instructions based on `LacifyRuntimev1.md`.
- [x] Provide prompting examples for adding an Actor, table, command, state, index, and summary.
- [x] Add an AI-safe project bootstrap template.
- [x] Generate TypeScript runtime clients and types after successful apply.
- [x] Return machine-readable validation diagnostics that map directly to files.
- [x] Add dry-run examples for Codex and other MCP-compatible coding agents.

### Acceptance criteria

- [x] Given a POS requirement, an agent can create a valid `Outlet` Actor and initial SQL migration.
- [x] Generated files are understandable and reviewable without Lacify-specific hidden state.
- [x] The agent does not place business rules in the stateless Worker.
- [x] The agent does not bypass review by calling Production mutation endpoints.

## Milestone 7 — End-to-end personal-platform acceptance

### Work

- [x] Initialize a fresh repository using the CLI.
- [x] Connect an AI coding agent through MCP.
- [x] Ask the agent to add a Business Aggregate and migration.
- [x] Validate and plan with no mutation.
- [x] Apply the repository project to remote Development after explicit browser/device approval.
- [x] Execute a generated-client-compatible command and verify SQLite persistence.
- [x] Modify the schema with a second forward-only migration.
- [x] Verify drift, telemetry, backup, and recovery evidence.
- [x] Verify the repository-derived immutable release can use the existing Staging and governed Production promotion path.
- [x] Complete security tests for workspace scope, plan replay, migration tampering, injection, and secret exposure.

### Acceptance criteria

- [x] The complete remote Development workflow can be performed from a project repository without manual Cloudflare configuration.
- [x] AI-created changes remain normal reviewable files in version control.
- [x] Development apply is reproducible from a clean checkout.
- [x] Production promotion consumes the exact verified source fingerprint created from the reviewed files.
- [x] Backup and rollback evidence exists before the Production schema changes.
- [x] No unresolved critical security, migration, or recovery issue remains.

### Current acceptance evidence

- The local end-to-end test covers clean initialization, MCP validation/plan, explicit Development apply, command persistence without payload disclosure, a second migration, migration history, Production blocking, and clean-checkout fingerprint reproducibility.
- The account owner completed browser/device authorization. The opaque CLI credential is protected by the operating-system credential store and remains revocable with `lacify logout`.
- A fresh `phase10-smoke` repository validated, planned, and applied to remote Development without manual Cloudflare configuration.
- The initial repository fingerprint compiled into immutable release `release_ace24057cc63f23454503b7e`; the forward-only second migration produced fingerprint `16a8d0af9e7638c422e14de9ab5e97223e61695c338c112834a292020e1df6f7` and verified release `release_1d86242cbe88a123b10ba461`.
- Deployment `deploy_1d86242cbe88a123b1_dev` succeeded at `https://phase10-smoke-dev-runtime.ajicayo16.workers.dev`.
- The same aggregate partition advanced from version 1 to 2 across the first release and to version 3 after the second migration, proving state survived immutable runtime replacement.
- Deep health verified the Worker, Durable Object, SQLite storage, migration ledger, and authored `aggregate_state` table without exposing business rows.
- The existing Phase 7–9 governance path promotes the same verified release identity and source fingerprint through Staging and Production. Phase 10 does not automatically perform a Production deployment because that remains an authorized user decision.

## Delivery order

1. Canonical file specification.
2. Migration engine and schema registry.
3. Local CLI.
4. Synchronization and drift.
5. MCP server.
6. AI authoring workflow.
7. End-to-end acceptance.

Do not build the MCP mutation tools before file normalization, validation, planning, and migration checksums are stable.

## Definition of done

Phase 10 is complete when an AI coding agent can inspect a personal Lacify project through MCP, create reviewable Actor and SQL migration files in a repository, validate and plan them without mutation, and apply an explicitly approved Development change through the CLI. The same file fingerprint must compile into an immutable release that can use the existing Staging and Production governance safely.

## Out of scope

- Arbitrary remote SQL against Production business data.
- PostgreSQL wire-protocol compatibility.
- General-purpose relational joins across Actor boundaries.
- AI access to raw secrets, credentials, customer records, or reversible partition IDs.
- Automatic destructive migrations.
- Automatic Production deployment without an authorized user decision.
- Chat, presence, multiplayer, collaborative editing, or long-lived WebSocket runtime patterns.
