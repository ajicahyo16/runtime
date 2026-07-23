# Lacify Runtime File Specification

This directory contains the Phase 10 canonical schemas, migration engine, CLI, MCP server, synchronization rules, client generator, templates, and fixtures.

## Files

- `schemas/lacify.runtime.schema.json`: project document JSON Schema.
- `schemas/actor.schema.json`: Actor document JSON Schema.
- `schemas/operation.schema.json`: typed command/query operation JSON Schema.
- `src/index.mjs`: executable loader, validation, normalization, and fingerprinting.
- `src/migration-engine.mjs`: deterministic planner, ledger, transactional apply, preflight, recovery, and schema introspection.
- `src/cli.mjs`: repository-first CLI implementation.
- `src/mcp-service.mjs`: bounded MCP resources and tools.
- `src/client-generator.mjs`: deterministic TypeScript runtime client generation.
- `src/module-system.mjs`: reusable Actor extension discovery, planning, staging, conflict detection, and approved installation.
- `src/encrypted-archive.mjs`: bounded authenticated encryption, verification, and isolated archive recovery.
- `src/workspace-catalog.mjs`: contained multi-project catalog, status aggregation, and module comparison.
- `src/project-blueprint.mjs`: immutable data-free project structure export, preview, and approved materialization.
- `modules/`: built-in immutable Actor extension modules.
- `fixtures/`: POS, inventory, booking, and approval examples.
- `templates/basic/`: AI-safe bootstrap template.
- [`AI_AUTHORING.md`](./AI_AUTHORING.md): concise agent rules and prompting examples.
- [`REFERENCE.md`](./REFERENCE.md): field and bounded SQL-dialect reference.

## Validation

```bash
npm run test:phase10
```

The loader rejects unknown keys, duplicate YAML keys, non-request-response runtime modes, invalid Actor or operation references, invalid state transitions, invalid secret names, unsafe migration or operation SQL, oversized files, missing files, and repository path escapes.

## Normalization

- Object keys are sorted recursively.
- Actor references, commands, operation references, secret references, summaries, state machines, states, and explicit transitions are sorted where order has no semantic meaning.
- Migration order is determined by the filename.
- Line endings are normalized to LF.
- The SHA-256 fingerprint covers the normalized project, Actor definitions, migration IDs, operation contracts, and SQL content.

No credentials, secret values, environment values, or business rows belong in these files.

## CLI

```bash
node bin/lacify.mjs init --project my-project
node bin/lacify.mjs validate
node bin/lacify.mjs modules
node bin/lacify.mjs module-plan workspace-tasks --actor Workspace
node bin/lacify.mjs add workspace-tasks --actor Workspace --plan module_plan_<id> --approve
node bin/lacify.mjs module-status
node bin/lacify.mjs module-upgrade-plan workspace-tasks --actor Workspace
node bin/lacify.mjs upgrade workspace-tasks --actor Workspace --plan module_upgrade_<id> --approve
node bin/lacify.mjs plan --env development
node bin/lacify.mjs test
node bin/lacify.mjs integrate
node bin/lacify.mjs review
node bin/lacify.mjs apply-review --review review_<id> --approve
node bin/lacify.mjs doctor
node bin/lacify.mjs snapshot --approve
node bin/lacify.mjs verify-snapshot --snapshot snapshot_<uuid>
node bin/lacify.mjs rehearse-restore --snapshot snapshot_<uuid> --approve
node bin/lacify.mjs archive-create --snapshot snapshot_<uuid> --output /absolute/private/project.lacify.enc --approve
node bin/lacify.mjs archive-info /absolute/private/project.lacify.enc
node bin/lacify.mjs archive-verify /absolute/private/project.lacify.enc
node bin/lacify.mjs archive-restore /absolute/private/project.lacify.enc --target ./recovered-project --approve
node bin/lacify.mjs dev --port 8788
```

Add `--json` for machine-readable output. Add `--remote` to an approved reviewed Development apply after `lacify login`; this synchronizes canonical contracts and authored SQL, records the source fingerprint, compiles and verifies an immutable release, and starts the governed remote Development deployment.

`lacify test` runs repository operation fixtures against isolated in-memory SQLite databases. `lacify dev` provides hot-reloading local command/query routes and optional validated `seeds/development.sql` data. Development seeds never enter fingerprints, releases, or remote environments.

`lacify review` reruns validation, local operation fixtures, and Development planning, then writes a metadata-only receipt under `.lacify/reviews/`. `lacify apply-review` recomputes that complete binding immediately before mutation and rejects changed files, plans, test failures, invalid receipt IDs, and stale replay.

`lacify integrate` generates the typed client, a trusted-server adapter, and a secret-free `.lacify/integration.json` manifest. `lacify doctor` checks the complete local application path. Add `--remote` after login to verify Control Plane visibility, the Development deployment, and runtime credential metadata without returning token values.

`lacify snapshot --approve` makes a consistent local Development copy of every Actor SQLite database. `lacify snapshots` lists bounded metadata, `lacify verify-snapshot` checks file hashes, SQLite integrity, and schema identity, and `lacify rehearse-restore --approve` proves restoration in isolated temporary databases without replacing active Development. Snapshot databases contain business data and belong under ignored `.lacify/backups/`, never in Git.

`lacify modules` lists built-in reusable object capabilities. `lacify module-plan` checks the target Actor boundary, repository conflicts, projected canonical validation, and composed SQLite schema without mutation. `lacify add` requires the exact unchanged plan and explicit approval, then creates normal migration, operation, and test files. Installed output is project-owned and continues through the standard test, integrate, review, and apply workflow.

Use `--version <semver>` during module plan and add to install an archived immutable version. `lacify module-status` compares installed files and Actor entries with that exact baseline. `lacify module-upgrade-plan` permits only additive latest-version changes; customized, changed, or removed existing files require manual merge. `lacify upgrade` applies only the exact explicitly approved plan.

`lacify archive-create` encrypts a verified matching snapshot plus its canonical recovery files with scrypt and AES-256-GCM. The passphrase must be supplied only through `LACIFY_ARCHIVE_PASSPHRASE`. `lacify archive-info` reads public cryptographic format metadata, `lacify archive-verify` authenticates and integrity-checks the full payload, and `lacify archive-restore` atomically creates a new recovered project directory. Archives and existing targets are never overwritten.

Create a personal multi-project workspace from its common parent directory:

```text
lacify workspace-init --name personal-platform
lacify workspace-add crm-personal
lacify workspace-add project-manager
lacify workspace-list
lacify workspace-status
lacify workspace-module-matrix
lacify workspace-mcp-config --project project-manager
```

Registered project paths must resolve inside the workspace root and project IDs must be unique. Workspace discovery is metadata-only. Apply, deploy, restore, and upgrade remain project commands; there is no bulk workspace mutation.

Reuse a project structure from the workspace root:

```text
lacify blueprint-export --project crm-personal --name crm-starter --version 1.0.0
lacify blueprints
lacify blueprint-info crm-starter --version 1.0.0
lacify blueprint-plan crm-starter --version 1.0.0 --project second-crm
lacify blueprint-create crm-starter --version 1.0.0 --project second-crm --plan blueprint_plan_<id> --approve
```

Blueprint export includes canonical schema and operation source only. Data-changing migrations, Development seeds, tests, SQLite files, credentials, environment state, module installation history, reviews, generated output, and deployments are excluded. The generated project is registered in the workspace but is not automatically applied or deployed. Add project-specific operation fixtures before review.

Blueprint v2 exports are composable:

```text
lacify blueprint-plan workspace-composable \
  --version 1.0.0 \
  --project delivery-workspace \
  --rename-actor Workspace=DeliveryWorkspace \
  --partition-key Workspace=deliveryWorkspaceId \
  --modules workspace-tasks

lacify blueprint-create workspace-composable \
  --version 1.0.0 \
  --project delivery-workspace \
  --rename-actor Workspace=DeliveryWorkspace \
  --partition-key Workspace=deliveryWorkspaceId \
  --modules workspace-tasks \
  --plan blueprint_plan_<id> \
  --approve
```

Repeat `--rename-actor` and `--partition-key` for multiple source Actors. `--modules` accepts comma-separated module names or `Actor:module` selectors; use `none` for no modules. Omit it to retain all source modules. Blueprint v1 remains supported but accepts only the project parameter.

## MCP

Configure an MCP-compatible coding agent to run:

```text
node /absolute/path/to/bin/lacify-mcp.mjs
```

Run it from the repository containing `lacify.runtime.yaml`. The server exposes bounded project, schema, operation, data-model, health, integration-readiness, local-recovery, encrypted-archive, module, upgrade, workspace-discovery, and blueprint resources plus 41 tools. An agent can inspect safe metadata, validate proposals, generate a client, run fixtures, prepare reviews, inspect readiness, request approved recovery/archive actions, and plan, install, or safely upgrade exact Actor extensions.

For a workspace, use `lacify workspace-mcp-config --project <project-id>`. It sets the selected repository root, `LACIFY_WORKSPACE_ROOT`, and `LACIFY_MCP_PROJECT`. Peer metadata remains discoverable, but all project tools stay bound to the selected ID. Switching mutation context requires a different explicit MCP configuration.

Blueprint MCP discovery and planning return metadata and hashes without canonical file contents. Approved creation additionally requires developer-or-higher role, the exact blueprint fingerprint and plan ID, and an MCP project context matching the blueprint source project.

For blueprint v2, `plan_project_from_blueprint` and `create_project_from_blueprint` also accept `actorRenames`, `partitionKeys`, and `modules`. The normalized composition is included in the immutable plan binding; changing any parameter blocks replay.

For AI-authored repository changes, call `prepare_project_change_review`, inspect the changed files and returned hashes, then call `apply_reviewed_development_change` with the exact review ID, project fingerprint, and explicit approval. Remote Development deployment is a separate opt-in boolean and requires authenticated Control Plane access.

Remote Development operation testing is a separate two-step flow: call `plan_development_operation_test`, review its hashes and bounded metadata, then call `execute_development_operation_test` with the exact unchanged plan and explicit approval. The MCP service never returns raw business rows or secret values.

Set `LACIFY_RUNTIME_APPLICATION_TOKEN` to a scoped Development credential before executing an approved remote operation test. The token is sent only as the runtime Bearer credential; it is excluded from plans, results, and `.lacify/audit.jsonl`.

## Application access

Deployed operation routes deny unauthenticated access. Create a runtime credential through the Control Plane for one environment and select only the Actor operations the application needs. Each Actor capability also defines `rateLimitPerMinute` and `maxPayloadBytes`.

The plaintext `lacify_runtime_*` token is returned once. Store it in a server-side secret manager and redeploy the selected environment to activate the new immutable access policy. Revocation also requires redeployment to remove the credential from the deployed policy.

Construct the generated SDK with the runtime URL and token:

```ts
const lacify = new LacifyClient(process.env.LACIFY_RUNTIME_URL!, process.env.LACIFY_RUNTIME_TOKEN!)
```

Do not embed a runtime credential in browser JavaScript or a public `VITE_*` variable. Call Lacify from a trusted application backend.

## Personal project quickstart

Bootstrap an immediately executable personal project:

```text
lacify init --project my-project --template personal
lacify validate
lacify test
lacify integrate
lacify mcp-config
lacify review
lacify doctor
```

The personal template includes an Actor, forward-only migration, typed command and query, deterministic fixture, and `AGENTS.md`. `lacify mcp-config` prints a generic MCP configuration using an environment-variable placeholder; it never reads or prints a runtime credential. After inspecting the AI-authored files and receipt, apply the exact change with `lacify apply-review --review <review-id> --approve`.
