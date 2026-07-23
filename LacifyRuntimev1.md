# Lacify Runtime v1

## Document role

This is the canonical product vision for Lacify Runtime v1. Detailed implementation and acceptance records live in [`phases/`](./phases/README.md).

## Product status

- Phases 1–9 are complete and deployed.
- The Control Console is available at `https://runtime.getlacify.com`.
- The current runtime model is Production-capable for request-response business systems.
- Phase 10 is complete. The repository, CLI, MCP, migration, generated-client, and remote Development workflow has passed end-to-end acceptance.
- Phase 11 is complete. Safe typed SQL operations, application credentials, generated SDK access, and governed live promotion passed end-to-end acceptance.
- Phase 12 is complete. Personal project bootstrap, MCP setup, runtime credential management, responsive Console access, and review-to-deploy handoff passed acceptance.

## Product definition

Lacify Runtime is a personal, AI-native active database/runtime for transactional business systems built on Cloudflare Workers, Durable Objects, and SQLite.

The developer experience should feel like database-as-code:

```text
AI creates reviewable files
  → Lacify validates and plans
  → user approves Development apply
  → Lacify compiles an immutable runtime
  → the verified release is promoted through governed environments
```

The deployed result is not a passive PostgreSQL-style database. It is a set of active Business Aggregate Actors that own state and business rules.

## Core philosophy: Lacify vs PostgreSQL

### PostgreSQL: passive archive warehouse

```text
Warehouse → shelves → drawers → documents
```

PostgreSQL stores and queries rows. The database does not inherently know that an Order may be paid only after validation or that stock must be adjusted transactionally with an Outlet workflow. Application code outside the database normally owns those rules.

### Lacify: active company of Actors

```text
Company → responsible employees → private memory and procedures
```

An `Outlet`, `Warehouse`, or `BookingCalendar` is an active Business Aggregate. Each aggregate partition is represented by a Durable Object with a private SQLite database and command lifecycle.

```text
Wake
  → Validate
  → Execute
  → Persist
  → Update Summary
  → Respond
  → Sleep
```

An Order or Payment is normally a record owned by an Actor; it is not automatically a Durable Object by itself.

## Runtime architecture

```text
Client application
  → stateless Cloudflare Worker router
    → Durable Object selected by Actor partition key
      → private SQLite transaction
        → lifecycle response
```

### Invariants

- Workers are stateless routers.
- Business rules execute inside the responsible Durable Object.
- Operational transactional data lives in that Actor's SQLite database.
- A Durable Object is a consistency and ownership boundary.
- R2 is used only for files and large binary assets.
- Heavy asynchronous processing may use Cloud Run or another explicit worker system.
- BigQuery or equivalent analytical storage is reserved for enterprise-scale analytics and reporting.
- Summary tables should be generated for bounded daily, monthly, and yearly reporting.
- Runtime telemetry must never interrupt a successful business command.
- Runtime v1 favors short request-response execution and minimal active duration.

## Supported domains

Lacify Runtime v1 is intended for systems such as:

- POS Mobile and POS Admin
- ERP
- Inventory and warehouse management
- CRM
- Booking and scheduling
- HR management
- Finance operations
- Retail and restaurant management
- Clinic operations
- Approval workflows
- Role-based administrative systems

Typical characteristics include:

- Business transactions
- CRUD within an aggregate boundary
- Inventory movements
- Financial operations
- Scheduling
- Approvals
- State machines
- Role management
- Bounded operational reporting

## Out of scope for Runtime v1

These workloads require a different long-lived or realtime runtime strategy:

- Chat
- Presence
- Multiplayer
- Collaborative editors
- Massive live dashboards
- Large-scale WebSocket infrastructure
- Realtime shared documents

They must not be introduced into Runtime v1 implicitly.

## Authoring model

### Current visual and Control Plane model

The deployed console supports:

- Project and Business Aggregate design
- Objects, fields, commands, and state flows
- Web App Blueprints
- Deterministic immutable releases
- Development, Staging, and Production deployment
- Deep Worker, Durable Object, and SQLite health
- Runtime telemetry, aggregate operations, incidents, and cost estimates
- Application sessions, workspace RBAC, environment configuration, governance, backup, recovery, and readiness

### Next repository model

Phase 10 introduces reviewable project files:

```text
lacify.runtime.yaml
actors/
  outlet/
    actor.yaml
    migrations/
      0001_initial.sql
.lacify/
  lock.json
```

The division of responsibility is deliberate:

- `lacify.runtime.yaml` identifies the project and included Actors.
- `actor.yaml` defines aggregate ownership, partition key, commands, lifecycle, summaries, and named secret dependencies.
- SQL migrations define the private SQLite schema owned by that Actor.
- `.lacify/lock.json` records the synchronized base revision and fingerprints; it contains no credentials.

SQL describes storage. It must not be used to guess Actor boundaries or business command semantics.

## AI and MCP usage

An AI coding agent should be able to:

- Discover projects available to the authenticated personal account.
- Inspect Actor definitions, schema fingerprints, and migration history.
- Read environment and deployment metadata without reading secret values.
- Create or edit normal repository files.
- Run read-only validation and deterministic planning.
- Request an explicitly approved Development apply.
- Inspect release, deployment, deep-health, and readiness evidence.

An AI coding agent must not:

- Receive Cloudflare Uplink tokens, application sessions, environment secret values, or encryption material.
- Read Production business rows by default.
- Treat privacy-safe partition hashes as reversible identifiers.
- Write business rules into the stateless Worker.
- Edit an already-applied migration.
- Run a destructive migration without explicit exceptional authorization.
- Deploy, roll back, or restore Production automatically.

## Intended personal workflow

```text
1. Open a normal software repository.
2. Connect Codex or another coding agent to Lacify MCP.
3. Ask the agent to add an Actor, command, state, or SQLite migration.
4. Review the generated YAML and SQL files.
5. Run `lacify review`.
6. Inspect the metadata-only receipt and the changed repository files.
7. Approve `lacify apply-review --review <review-id> --approve`.
8. Use the generated client and types in the application.
9. Verify behavior, health, and telemetry.
10. Promote the exact immutable release through Staging and Production.
```

## Implementation roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| [Phase 1](./phases/phase1_ui_ux_visuals.md) | Control Console UI/UX foundation | Complete |
| [Phase 2](./phases/phase2_cloudflare_integration.md) | Secure Cloudflare Uplink | Complete |
| [Phase 3](./phases/phase3_durable_object_sqlite_generator.md) | Business Aggregate and SQLite generator | Complete |
| [Phase 4](./phases/phase4_lifecycle_execution_visualizer.md) | Lifecycle simulation and visualizer | Complete |
| [Phase 5](./phases/phase5_deployment_and_user_portal.md) | Web App Blueprint and deployment experience | Complete |
| [Phase 6](./phases/phase6_real_runtime_compiler.md) | Deterministic runtime compiler | Complete |
| [Phase 7](./phases/phase7_production_runtime_and_delivery.md) | Production runtime and environment delivery | Complete |
| [Phase 8](./phases/phase8_runtime_observability.md) | Runtime observability and aggregate operations | Complete |
| [Phase 9](./phases/phase9_application_access_and_production_readiness.md) | Access, governance, recovery, and readiness | Complete |
| [Phase 10](./phases/phase10_database_as_code_cli_and_mcp.md) | Database-as-code, CLI, and MCP | Complete |
| [Phase 11](./phases/phase11_executable_data_operations.md) | Executable data operations and typed application access | Complete |
| [Phase 12](./phases/phase12_personal_developer_platform.md) | Personal project bootstrap, AI setup, and runtime access | Complete |
| [Phase 13](./phases/phase13_ai_native_project_workflow.md) | Deterministic AI change review and exact Development apply | Complete |
| [Phase 14](./phases/phase14_real_application_integration.md) | Trusted backend adapter and end-to-end project readiness | Complete |
| [Phase 15](./phases/phase15_personal_data_backup_and_portability.md) | Verifiable local snapshots and isolated recovery rehearsal | Complete |
| [Phase 16](./phases/phase16_composable_actor_extensions.md) | Reusable object modules composed into existing Actors | Complete |
| [Phase 17](./phases/phase17_module_versioning_and_safe_upgrades.md) | Immutable module versions and customization-safe upgrades | Complete |
| [Phase 18](./phases/phase18_encrypted_backup_and_data_portability.md) | Authenticated encrypted archives and isolated recovery | Complete |
| [Phase 19](./phases/phase19_multi_project_workspace_and_ai_discovery.md) | Contained multi-project workspace and explicit AI project context | Complete |
| [Phase 20](./phases/phase20_reusable_project_blueprints.md) | Immutable data-free project blueprints and approved generation | Complete |
| [Phase 21](./phases/phase21_parameterized_blueprint_composition.md) | Typed Actor, partition, and module composition from immutable blueprints | Complete |

## Runtime v1 definition of success

Lacify Runtime v1 succeeds when a developer or AI coding agent can describe a transactional Business Aggregate in reviewable files, safely apply its SQLite evolution, compile it into an immutable Actor runtime, and use the generated client from a real project—without manually configuring Durable Objects or moving business rules into a stateless Worker.

For a personal platform with several projects, `lacify.workspace.yaml` provides bounded metadata-only discovery. Every registered project remains an independent runtime and storage boundary. An MCP process is rooted in one repository and bound to that exact project ID; discovering a peer project never authorizes mutation of it.

A proven project may be exported as an immutable blueprint containing only canonical Actor schema and operation source. Blueprint materialization assigns a new project ID, fingerprint, lock state, tests, and runtime lifecycle. It never clones source rows, fixtures, SQLite databases, credentials, reviews, releases, or deployments.

Composable blueprint v2 metadata identifies module-owned files and Actor patches. Before creation, a developer or AI may rename Actors, choose new partition-key identifiers, and retain an explicit subset of source modules. Lacify removes unselected files and Actor entries, then compiles the projected migrations and operation SQL in isolated SQLite before producing an approval-bound plan.
