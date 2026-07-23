# Phase 17: Module Versioning and Safe Upgrades

## Status

**Complete — all five milestones passed, including a governed live 1.0.0 → 1.1.0 upgrade.**

## Objective

Allow reusable Actor extensions to evolve without overwriting project customizations or editing previously installed migrations.

The upgrade loop is:

```text
installed immutable module baseline
  → compare repository files and Actor entries
    → discover latest built-in version
      → additive-only upgrade plan
        → exact explicit approval
          → standard test, review, Development apply, and recovery
```

Customized installations are reported for manual merge. Automatic upgrade is limited to new files and new Actor entries.

## Milestone 1 — Immutable version registry

- [x] Add semantic module versions.
- [x] Preserve the exact `workspace-tasks@1.0.0` manifest and fingerprint.
- [x] Publish `workspace-tasks@1.1.0`.
- [x] Allow explicit installation of an archived version.
- [x] Keep the root manifest as the latest trusted built-in version.
- [x] Record installed version and fingerprint in project provenance.

### Completion evidence

- The legacy 1.0.0 fingerprint remains `f812229ead733f6bdc5270dec01c60bbc584f59c090fd8c21d6e1d54a56bcaa8`.
- Version 1.1.0 has an independent immutable fingerprint.
- Existing Phase 16 records without a version resolve through their exact fingerprint.

## Milestone 2 — Installed state and customization detection

- [x] Add `lacify module-status`.
- [x] Resolve the latest installation per module and Actor.
- [x] Compare every installed file with its version baseline.
- [x] Verify installed Actor command and operation entries.
- [x] Report `current`, `update-available`, `customized`, or `unresolved`.
- [x] Return only paths and fingerprints, never source content.

### Completion evidence

- An unchanged 1.0.0 installation reports update available.
- A 1.1.0 installation reports current.
- Even a whitespace-only project customization is detected by baseline hash comparison.
- Missing Actor entries are reported independently from customized files.

## Milestone 3 — Additive-only upgrade planning

- [x] Add `lacify module-upgrade-plan <module> --actor <Actor>`.
- [x] Compare installed and latest target sets.
- [x] Block changed or removed existing files.
- [x] Block command, operation, file, and composed-schema conflicts.
- [x] Stage the projected repository and execute all migrations in isolated SQLite.
- [x] Bind project, baseline, latest module, additions, and projected fingerprint into one plan.

### Completion evidence

- The 1.0.0 → 1.1.0 plan adds four files and one Actor command/operation.
- Existing module files are not rewritten.
- The plan exposes paths, sizes, and hashes without SQL statement content.
- Customized installations are blocked with explicit manual-merge guidance.

## Milestone 4 — Approved CLI and MCP upgrades

- [x] Add `lacify upgrade <module> --actor <Actor> --plan <id> --approve`.
- [x] Reject stale plan replay.
- [x] Roll back newly created files and Actor changes after write failure.
- [x] Append immutable upgrade provenance.
- [x] Add MCP status, plan, and upgrade tools.
- [x] Require developer-or-higher role, exact project fingerprint, and explicit approval.

### Completion evidence

- Lacify MCP exposes 30 bounded tools.
- CLI and MCP return before/after project fingerprints and versions without SQL or business rows.
- MCP audit records upgrade identity and outcome only.

## Milestone 5 — Multi-version and live-vault acceptance

- [x] Keep one test project on 1.0.0 while another installs the latest module.
- [x] Upgrade an unchanged project automatically.
- [x] Block an independently customized project.
- [x] Upgrade the live personal vault from 1.0.0 to 1.1.0.
- [x] Run tests, integration generation, v2 review, remote Development apply, health, snapshot, and restore rehearsal.
- [x] Run complete quality gates.

### Completion evidence

- `workspace-tasks@1.1.0` adds task priority through migration `0120_task_priority` and operation `SetTaskPriority`.
- Project fingerprint changed to `46a291eea7b226c471ff2246c9e73785d37555d8f070b12c026c6cec088115ed`.
- Review `review_0f89334d0a74d84d39ee005b8bde3087a1fc9efa` passed four local fixtures.
- Release `release_26180d37ac7c90824538f225` was verified.
- Development deployment `deploy_26180d37ac7c908245_dev` succeeded and passed runtime health.
- Snapshot `snapshot_4d5441a0-2979-4637-b218-130a929df30b` and rehearsal `rehearsal_348df063-f8d2-4ec6-8be4-d34757bfd0a2` passed.
- The complete suite passes 98 tests: 35 Control Plane/hosting tests and 63 runtime-spec tests.
- The generated integration compiles under strict TypeScript, the production build passes, `npm audit` reports zero vulnerabilities, the workspace scan passes across 247 text files, and `git diff --check` is clean.

## Definition of done

Phase 17 is complete when projects can remain on different module versions, unchanged installations can receive a deterministic additive upgrade, customized installations are never overwritten, and a live upgrade passes the full governed Development and recovery workflow.

## Out of scope

- Automatically merging customized files.
- Editing or removing installed migrations.
- Downgrading a module.
- Destructive schema upgrades.
- Remote untrusted registries.
- Automatic Staging or Production promotion.
