# Phase 15: Personal Data Backup and Portability

## Status

**Complete — all five milestones passed, including a real vault snapshot and isolated restore rehearsal.**

## Objective

Give a personal Lacify project a verifiable local recovery path before a real application begins accumulating important data.

The recovery loop is:

```text
applied local Development
  → explicitly approved consistent SQLite snapshot
    → per-Actor checksum and schema identity
      → integrity verification
        → isolated temporary restore
          → metadata-only recovery evidence
```

Snapshot databases contain business data and must remain outside source control. CLI and MCP responses must return metadata only.

## Milestone 1 — Consistent Actor snapshots

- [x] Add `lacify snapshot --approve`.
- [x] Restrict snapshots to local Development.
- [x] Require Development to match the current project fingerprint.
- [x] Use the Node SQLite backup API for a consistent copy.
- [x] Snapshot every Actor database as one recovery set.
- [x] Remove incomplete snapshot directories after failure.

### Completion evidence

- Each snapshot has an opaque UUID identity.
- Each Actor entry records file path, byte size, SHA-256 checksum, schema fingerprint, and migration ledger metadata.
- The manifest explicitly declares that the snapshot contains business data.
- Snapshot output never includes business rows.

## Milestone 2 — Inventory and integrity verification

- [x] Add `lacify snapshots`.
- [x] Add `lacify verify-snapshot --snapshot <id>`.
- [x] Validate snapshot and Actor path contracts.
- [x] Verify the full-file SHA-256 checksum.
- [x] Run SQLite `PRAGMA integrity_check`.
- [x] Compare the restored schema fingerprint with the manifest.

### Completion evidence

- Snapshot listings contain bounded metadata for at most 100 snapshots.
- Verification opens snapshot databases read-only.
- A one-byte snapshot modification is detected and produces a failed result.
- No verification response contains table rows.

## Milestone 3 — Non-destructive restore rehearsal

- [x] Add `lacify rehearse-restore --snapshot <id> --approve`.
- [x] Restore into an isolated temporary directory.
- [x] Re-run checksum, SQLite integrity, and schema checks.
- [x] Delete temporary database copies after the rehearsal.
- [x] Save metadata-only recovery evidence.
- [x] Never overwrite active Development.

### Completion evidence

- Rehearsal evidence records the snapshot, project fingerprint, checks, and result.
- `isolatedTemporaryRestore` is true.
- `activeDevelopmentOverwritten` is false.
- Tests confirm the active private row remains unchanged after rehearsal.

## Milestone 4 — AI-safe backup operations

- [x] Add MCP snapshot listing, creation, verification, and restore-rehearsal tools.
- [x] Require developer-or-higher role for snapshot and rehearsal actions.
- [x] Require explicit approval for actions that copy business data.
- [x] Audit MCP snapshot and rehearsal identities without payloads.
- [x] Keep active restore and Production restore outside MCP.

### Completion evidence

- Lacify MCP exposes 24 bounded tools.
- Snapshot creation and restore rehearsal reject missing approval.
- MCP results explicitly return no business rows.
- Audit entries contain only project, fingerprint, snapshot/rehearsal identity, actor-independent outcome, user, and role.

## Milestone 5 — Personal-vault acceptance and repository safety

- [x] Snapshot the real local `personal-project-vault` Development database.
- [x] Verify checksum, SQLite integrity, and schema fingerprint.
- [x] Pass an isolated restore rehearsal.
- [x] Exclude Development databases, snapshots, and recovery copies from Git.
- [x] Run complete regression, build, security, and formatting gates.

### Completion evidence

- Snapshot `snapshot_b702d6fc-ae7c-4313-bd47-30045daa02f4` contains one 28,672-byte `Workspace` database.
- Restore rehearsal `rehearsal_a9ec1412-19e7-4193-822f-c8e0a0d2ad37` passed all checks.
- Active Development was not overwritten.
- `.gitignore` protects `.lacify/development`, `.lacify/backups`, and `.lacify/recovery` at any repository depth.
- The complete suite passes 94 tests: 35 Control Plane/hosting tests and 59 runtime-spec tests.
- The production build passes, `npm audit` reports zero vulnerabilities, the workspace scan passes across 205 text files, and `git diff --check` is clean.

## Definition of done

Phase 15 is complete when a developer or AI can create an explicitly approved local Development snapshot, verify its cryptographic and SQLite integrity, and prove restoration in isolation without exposing rows or overwriting the active database.

## Out of scope

- Committing snapshot databases to source control.
- Returning backup business rows through CLI or MCP.
- Automatic cloud upload or third-party storage.
- In-place Development, Staging, or Production restore.
- Production recovery without existing Control Plane governance.
