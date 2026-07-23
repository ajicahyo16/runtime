# Phase 20: Reusable Project Blueprints

## Status

**Complete — all five milestones passed with an independent CRM project created from an immutable blueprint.**

## Objective

Reuse the proven structure of one Lacify project without cloning its runtime identity or private state.

```text
reviewable source project
  → immutable data-free blueprint
    → metadata-only preview
      → exact approved creation plan
        → new project ID and fingerprint
          → project-specific tests, review, and apply
```

A blueprint is reusable source structure, not a database backup and not a deployment clone.

## Milestone 1 — Bounded immutable blueprint contract

- [x] Add `lacify.dev/blueprint/v1`.
- [x] Store immutable semantic versions under the workspace catalog.
- [x] Bind Actor metadata, module provenance, canonical file hashes, exclusions, and the source fingerprint into a blueprint fingerprint.
- [x] Limit names, versions, Actors, modules, file count, individual file size, and total source size.
- [x] Reject unknown fields, unsafe paths, non-regular files, checksum changes, and version overwrite.

### Completion evidence

- Blueprint versions are stored under `.lacify/blueprints/<name>/<version>/`.
- A changed manifest or canonical source file fails integrity verification.
- A published name/version cannot be replaced.

## Milestone 2 — Data-free structure export

- [x] Add `lacify blueprint-export`.
- [x] Export only `lacify.runtime.yaml`, Actor definitions, schema migrations, and typed operation contracts/SQL.
- [x] Record only module name/version/fingerprint provenance when installed modules are current and uncustomized.
- [x] Block customized, unresolved, or outdated module baselines.
- [x] Block migrations containing `INSERT` or `UPDATE`.

### Completion evidence

The export excludes:

- business rows and Development seeds;
- operation fixtures;
- SQLite databases and snapshots;
- credentials and environment lock state;
- module installation history;
- review receipts and audit logs;
- generated clients and server adapters;
- releases, deployments, and telemetry.

## Milestone 3 — Deterministic preview and safe creation

- [x] Add `lacify blueprints` and `lacify blueprint-info`.
- [x] Add `lacify blueprint-plan`.
- [x] Require a new bounded project ID and direct-child target path.
- [x] Reject existing project IDs and paths.
- [x] Bind the blueprint fingerprint, target, projected fingerprint, and every generated file hash into the plan.
- [x] Add `lacify blueprint-create` with exact plan replay and explicit approval.
- [x] Materialize through an isolated staging directory and register the completed project in the workspace.

### Completion evidence

- The new project receives an empty environment lock, current AI instructions, and a test-authoring guide.
- Source fixtures are not copied; the new project must define its own behavioral tests.
- A destination appearing after planning stops creation without overwrite.
- Creation performs no remote mutation.

## Milestone 4 — MCP blueprint workflow

- [x] Add blueprint list, inspect, plan, and create tools.
- [x] Return hashes and metadata instead of canonical file contents or rows.
- [x] Require developer-or-higher role and explicit approval for creation.
- [x] Require the MCP-selected project to match the blueprint source project.
- [x] Require the exact blueprint fingerprint and plan ID.
- [x] Audit only source, blueprint, target, and fingerprint metadata.

### Completion evidence

- Lacify MCP exposes 41 bounded tools.
- A peer project can preview a blueprint but cannot create from it without selecting the source context.
- MCP results and audit events contain no SQL source, credentials, or business rows.

## Milestone 5 — Independent CRM acceptance

- [x] Export `crm-starter@1.0.0` from `crm-personal`.
- [x] Create `crm-operations` through the approved blueprint plan.
- [x] Add a new project-specific operation fixture after materialization.
- [x] Integrate, review, and locally apply the new project.
- [x] Verify all workspace projects remain ready.
- [x] Run complete quality gates.

### Completion evidence

- Blueprint fingerprint: `708f21f4626611a1bcfa9b67b19b21a7203bdcd0b51ba378d2f9cbff4719e71e`.
- Source fingerprint: `398a1d35c1e11764d0479a08f411eb7b54999b412937e4c7fbe96d0cdb584f4d`.
- New project fingerprint: `d6870c93e326cf407661003172341b5344e547bdf830e1ca0e53ec86094cb429`.
- Review receipt: `review_0ecac9ccc54e40fa9b8679e59ecb817b16db96e5`.
- The source and generated projects share five operation contracts but have different project identities and local SQLite databases.
- All four personal-workspace projects report ready with zero blockers.
- The complete suite passes 104 tests: 35 Control Plane/hosting tests and 69 runtime-spec tests.
- The production build passes, `npm audit` reports zero vulnerabilities, the workspace security scan passes, and `git diff --check` is clean.

## Definition of done

Phase 20 is complete when a developer or AI agent can turn an existing project structure into an immutable, inspectable, data-free blueprint and create a separately identified project through an exact approved plan without copying source runtime state.

## Out of scope

- Copying source business rows, fixtures, SQLite files, snapshots, or secrets.
- Cloning releases, deployments, runtime credentials, or environment state.
- Treating module provenance as module installation history in the new project.
- Overwriting an existing blueprint version or project directory.
- Automatically applying or deploying the generated project.
- Cross-project database access.
