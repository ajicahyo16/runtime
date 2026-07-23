# Phase 16: Composable Actor Extensions

## Status

**Complete — all five milestones passed, including governed live Development composition.**

## Objective

Reuse a proven object capability across projects without forcing every project to have the same objects or creating duplicate Actors.

The composition loop is:

```text
existing Actor ownership boundary
  → choose reusable object module
    → deterministic conflict-checked plan
      → explicit approved repository installation
        → normal tests, integration, review, and Development apply
```

An extension adds migrations, operations, commands, and tests to an existing Actor. Each project keeps independent files, data, deployment, and credentials.

## Milestone 1 — Actor extension module contract

- [x] Add a versioned `lacify.dev/module/v1` manifest.
- [x] Declare required partition key and storage.
- [x] Declare additive Actor commands and operation references.
- [x] Package migrations, operation contracts, SQL, and deterministic tests.
- [x] Restrict source and destination paths.
- [x] Fingerprint the complete immutable module content.

### Completion evidence

- Modules are limited to 64 files of at most 1 MiB each.
- Module targets can write only Actor migrations, Actor operations, or project operation tests.
- Project test Actor names are materialized for the selected target Actor.
- Invalid modules are never advertised.

## Milestone 2 — Reusable Workspace objects

- [x] Add `workspace-projects`.
- [x] Add `workspace-tasks`.
- [x] Keep both as extensions of a `workspaceId`-partitioned SQLite Actor.
- [x] Include typed commands, queries, pagination, and tests.
- [x] Allow projects to select either or both modules.

### Completion evidence

- `workspace-projects` adds project storage plus Create, Get, and List operations.
- `workspace-tasks` adds task storage plus Create, Complete, and List operations.
- Two test projects retain one `Workspace` Actor while exposing different object sets.

## Milestone 3 — Deterministic planning and conflict safety

- [x] Add `lacify modules`.
- [x] Add `lacify module-plan <module> --actor <Actor>`.
- [x] Check Actor existence, partition, storage, commands, operations, and file collisions.
- [x] Stage the projected repository in isolation.
- [x] Validate the projected canonical project.
- [x] Execute the composed migration chain against isolated SQLite.
- [x] Return paths, sizes, and hashes without SQL source.

### Completion evidence

- Plan identity binds source project fingerprint, module fingerprint, target Actor, Actor patch, generated files, and projected fingerprint.
- Existing commands, operations, files, tables, and incompatible Actor boundaries block installation.
- Planning never changes repository or remote state.

## Milestone 4 — Approved CLI and MCP installation

- [x] Add `lacify add <module> --actor <Actor> --plan <id> --approve`.
- [x] Reject stale plan replay.
- [x] Roll back newly created files if installation fails.
- [x] Record installed module provenance in `.lacify/modules.json`.
- [x] Add MCP list, plan, and install tools.
- [x] Require developer-or-higher role and explicit approval through MCP.

### Completion evidence

- Lacify MCP exposes 27 bounded tools.
- Installation returns repository file paths and before/after fingerprints only.
- MCP audit contains module identity and fingerprints without SQL or business rows.
- Reinstalling the same module is blocked by deterministic conflicts.

## Milestone 5 — Governed personal-vault acceptance

- [x] Plan `workspace-tasks` against the existing `Workspace` Actor.
- [x] Preserve the existing Projects object in the same Actor.
- [x] Install and pass all local operation fixtures.
- [x] Generate the updated backend integration.
- [x] Create a metadata-only v2 review receipt.
- [x] Apply the additive migration locally and deploy the exact release to remote Development.
- [x] Snapshot and rehearse recovery for the new fingerprint.
- [x] Run complete quality gates.

### Completion evidence

- Project fingerprint changed from `ed907f3115c4794c63b042e5b4280d7bda1d50d7b75eb74264caf8c63b0e8a30` to `95f6a6ae697cf8495d6bdd6f5bae9fe0c8793dc3f28ab9bce3b1d7e6f68957ee`.
- The project still has one `Workspace` Actor, now with Projects and Tasks.
- Review `review_1789ff475760d9b06eb7d64f230725005b5d8c37` binds the additive change without SQL statements.
- Release `release_7fe0ba0731d75a8253df11fe` was verified.
- Development deployment `deploy_7fe0ba0731d75a8253_dev` succeeded and passed runtime health.
- Snapshot `snapshot_178de6a3-26df-4c7f-8c6c-41b1b7220522` and rehearsal `rehearsal_65ef924d-d90f-4c14-a6e1-31548c0e42ab` passed.
- The complete suite passes 97 tests: 35 Control Plane/hosting tests and 62 runtime-spec tests.
- The generated integration compiles under strict TypeScript, the production build passes, `npm audit` reports zero vulnerabilities, the workspace scan passes across 236 text files, and `git diff --check` is clean.

## Definition of done

Phase 16 is complete when two projects can reuse the same Actor extension independently, one Actor can compose multiple object modules without duplication, and a live additive extension passes deterministic planning, review, Development deployment, health, and recovery checks.

## Out of scope

- Sharing business rows or credentials between projects.
- Automatically upgrading customized installed module files.
- Removing a module or rolling back its schema automatically.
- Installing modules directly into Staging or Production.
- Untrusted remote module registries.
