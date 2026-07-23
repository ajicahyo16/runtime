# Phase 13: AI-Native Project Workflow

## Status

**Complete — all five milestones passed.**

## Objective

Make a real software repository the safe handoff point between a developer, an AI coding agent, and Lacify Runtime.

The primary loop is:

```text
developer request
  → AI edits migration, operation, and test files
    → Lacify validates the complete repository
      → deterministic metadata-only review receipt
        → human approves the exact receipt
          → unchanged Development apply
            → generated SDK is consumed by a trusted backend
```

The review boundary must bind the complete canonical source state without copying SQL, credentials, or business rows into MCP results or audit records.

## Milestone 1 — Deterministic project review receipt

- [x] Add `lacify review`.
- [x] Validate the canonical project and Development migration plans.
- [x] Run all deterministic local operation fixtures.
- [x] Hash the canonical runtime, Actor, migration, operation, and test files.
- [x] Save a bounded receipt under `.lacify/reviews/`.
- [x] Exclude source contents, credentials, and business rows from the receipt.

### Completion evidence

- Review receipt v2 binds the project fingerprint, source-manifest fingerprint, environment, and sorted migration plan IDs.
- Source files are represented only by repository-relative path, byte count, and SHA-256 hash.
- Pending migrations expose checksum, classification, and change counts without statement text.
- Reviews are limited to 2,048 files and 16 MiB of canonical source.
- An existing receipt is never overwritten with different content.

## Milestone 2 — Exact reviewed Development apply

- [x] Add `lacify apply-review --review <review-id> --approve`.
- [x] Re-run validation, tests, source hashing, and planning immediately before apply.
- [x] Block changed source files, changed plans, invalid receipts, and stale replay.
- [x] Keep direct CLI apply restricted to Development.
- [x] Support `--remote` only after the exact receipt passes and CLI authentication is available.

### Completion evidence

- A valid receipt applies and records its ID as `reviewedBy`.
- Changing one valid Actor field after review blocks apply before any Development mutation.
- A receipt becomes stale after its migration plan changes.
- Staging and Production remain governed immutable promotion targets rather than CLI apply targets.

## Milestone 3 — MCP review and approval tools

- [x] Add `prepare_project_change_review`.
- [x] Add `apply_reviewed_development_change`.
- [x] Enforce owner, admin, or developer role for mutation.
- [x] Require explicit approval and an exact project fingerprint.
- [x] Keep remote Development deployment opt-in.
- [x] Audit reviewed applies without payloads or business rows.

### Completion evidence

- Lacify MCP now exposes 19 bounded tools.
- Preparing a review is local and read-only except for its metadata receipt.
- MCP results declare that no business rows are returned.
- Reviewed apply audit entries contain identity, role, project fingerprint, review ID, remote flag, and result only.

## Milestone 4 — Real personal-project handoff

- [x] Document the end-to-end AI workflow in the personal project.
- [x] Replace the loose validate/plan/apply sequence with review/apply-review guidance.
- [x] Keep generated SDK credentials server-side.
- [x] Preserve the existing sanitized live project evidence.

### Completion evidence

- `examples/personal-project/AI_WORKFLOW.md` gives the developer and AI agent one shared protocol.
- The personal template's `AGENTS.md` tells agents to prepare a review receipt before requesting approval.
- The runtime specification quickstart documents local and remote reviewed apply.

## Milestone 5 — Regression and security acceptance

- [x] Add CLI tests for receipt creation, reviewed apply, and changed-source rejection.
- [x] Add MCP tests for preparation, approval, audit, and payload exclusion.
- [x] Run the complete Control Plane and runtime-spec suites.
- [x] Run the production build and workspace security checks.
- [x] Confirm formatting integrity.

### Completion evidence

- CLI and MCP review-specific tests pass.
- The complete suite passes 92 tests: 35 Control Plane/hosting tests and 57 runtime-spec tests.
- TypeScript and Vite production builds pass.
- `npm audit` reports zero vulnerabilities, the workspace scan passes across 196 text files, and `git diff --check` is clean.
- No live Production mutation is required for this repository-workflow phase.

## Definition of done

Phase 13 is complete when an AI can author normal Lacify project files, produce one deterministic and inspectable review receipt, and request an explicitly approved Development apply that is rejected if any bound source or plan changed.

## Out of scope

- Automatic Production deployment or promotion.
- Placing runtime credentials in prompts, receipts, generated browser code, or repository files.
- Applying arbitrary SQL that is not part of validated canonical project files.
- Reading Production business rows through MCP.
- Treating the review receipt as a replacement for source-code review.
