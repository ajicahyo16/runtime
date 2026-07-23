# Phase 18: Encrypted Backup and Data Portability

## Status

**Complete — all five milestones passed, including an encrypted live-vault round trip.**

## Objective

Make a verified Lacify snapshot portable beyond the primary computer without exposing its business data or allowing restore to overwrite an existing project.

The portability loop is:

```text
verified local snapshot
  → project recovery bundle
    → scrypt-derived encryption key
      → AES-256-GCM authenticated archive
        → offline authentication and integrity verification
          → atomic restore into a new directory
```

The passphrase exists only in the protected process environment. It is never accepted as a CLI/MCP argument and never returned, logged, audited, or stored in the archive.

## Milestone 1 — Bounded encrypted archive format

- [x] Add the `lacify.archive/v1` binary format.
- [x] Derive a 256-bit key with scrypt and a random 16-byte salt.
- [x] Encrypt with AES-256-GCM and a random 12-byte IV.
- [x] Authenticate the magic header and cryptographic metadata as additional data.
- [x] Enforce 384 MiB plaintext-source and 512 MiB archive bounds.
- [x] Restrict embedded project paths and ignore symlinks.

### Completion evidence

- The archive contains canonical project files, lock/integration/module/review metadata, snapshot manifest, and Actor SQLite databases.
- Archive headers expose only format, cipher, KDF, salt, IV, tag length, and creation time.
- The encrypted payload does not expose project names, schema, credentials, or business rows.

## Milestone 2 — Creation and safe key handling

- [x] Add `lacify archive-create`.
- [x] Require an absolute non-existing output path.
- [x] Require explicit approval because the encrypted payload contains business data.
- [x] Require `LACIFY_ARCHIVE_PASSPHRASE` with 16–1,024 UTF-8 bytes.
- [x] Verify the source snapshot before encryption.
- [x] Require the snapshot fingerprint to match the current project.
- [x] Write the archive with owner-only permissions.

### Completion evidence

- Existing archive files are never overwritten.
- Results contain archive ID, byte size, project fingerprint, snapshot ID, and Actor count only.
- Results explicitly declare that no passphrase or business rows were returned.
- `*.lacify.enc` is excluded from Git.

## Milestone 3 — Authentication and verification

- [x] Add `lacify archive-info`.
- [x] Add `lacify archive-verify`.
- [x] Inspect format metadata without decrypting the payload.
- [x] Authenticate the complete encrypted archive.
- [x] Verify embedded project-file and Actor checksums.
- [x] Run SQLite integrity and schema fingerprint checks in temporary files.
- [x] Delete all temporary verification databases.

### Completion evidence

- A correct passphrase verifies the archive.
- A wrong passphrase fails with a bounded authentication error.
- A one-bit encrypted archive modification fails authentication.
- Verification returns no row data.

## Milestone 4 — Atomic isolated restore

- [x] Add `lacify archive-restore`.
- [x] Require explicit approval.
- [x] Refuse an existing target path.
- [x] Build the recovered project in a temporary sibling directory.
- [x] Restore canonical files, snapshot evidence, and active local Development databases.
- [x] Validate the restored canonical project fingerprint.
- [x] Atomically rename the completed recovery directory into place.
- [x] Clean incomplete staging directories after failure.

### Completion evidence

- Recovered projects receive local Git exclusions for Development, backups, and recovery data.
- Restore evidence declares an isolated target and no existing-project overwrite.
- Tests confirm private rows exist in the recovered database and remain unchanged in the source database.
- Repeating restore into the same target is rejected.

## Milestone 5 — MCP and live-vault acceptance

- [x] Add MCP inspect, create, verify, and restore tools.
- [x] Keep the passphrase in the MCP process environment only.
- [x] Require developer-or-higher role and explicit approval for create/restore.
- [x] Audit archive identity without file paths, keys, or rows.
- [x] Encrypt, verify, and restore the current personal vault snapshot.
- [x] Delete the ephemeral acceptance archive and restored copy.
- [x] Run complete quality gates.

### Completion evidence

- Lacify MCP exposes 34 bounded tools.
- Live archive `archive_e96827cf8568d0b819987f6ae2d8de2a616c009c` contained 94,207 encrypted bytes.
- It restored project fingerprint `46a291eea7b226c471ff2246c9e73785d37555d8f070b12c026c6cec088115ed`.
- Workspace checksum, SQLite integrity, and schema identity passed.
- The ephemeral passphrase was never returned and the acceptance archive/restore directory was deleted.
- The complete suite passes 99 tests: 35 Control Plane/hosting tests and 64 runtime-spec tests.
- The generated integration compiles under strict TypeScript, the production build passes, `npm audit` reports zero vulnerabilities, the workspace scan passes across 250 text files, and `git diff --check` is clean.

## Definition of done

Phase 18 is complete when a developer can turn a verified snapshot into a tamper-evident encrypted archive, verify it offline, and restore the complete personal project into a new isolated directory without exposing keys or rows and without overwriting existing data.

## Out of scope

- Recovering a forgotten archive passphrase.
- Uploading archives to third-party storage automatically.
- Overwriting an existing project or active database.
- Streaming archives larger than the v1 memory bounds.
- Staging or Production restore.
- Sharing archive keys through MCP arguments, logs, or repository files.
