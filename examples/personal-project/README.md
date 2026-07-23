# Personal Project Vault

This Phase 11 acceptance project stores personal project metadata in Actor-owned SQLite.

```text
node ../../bin/lacify.mjs validate
node ../../bin/lacify.mjs test
node ../../bin/lacify.mjs modules
node ../../bin/lacify.mjs module-status
node ../../bin/lacify.mjs integrate
node ../../bin/lacify.mjs review
node ../../bin/lacify.mjs doctor --remote
node ../../bin/lacify.mjs snapshot --approve
```

The generated TypeScript SDK requires a server-side `lacify_runtime_*` credential scoped to the `Workspace` Actor and its declared operations. Never expose that credential in browser JavaScript.

See [ACCEPTANCE.md](./ACCEPTANCE.md) for the sanitized live Phase 11 acceptance record.
See [AI_WORKFLOW.md](./AI_WORKFLOW.md) for the Phase 13 review and approval protocol.

`backend/project-store.ts` demonstrates a trusted application wrapper. Supply `LACIFY_RUNTIME_URL` and `LACIFY_RUNTIME_TOKEN` through the backend deployment environment, never through browser-visible variables.

Local snapshots contain the complete Actor SQLite data. Keep `.lacify/backups/` outside Git and copy important snapshots to an appropriately protected storage location using your normal encrypted backup process.

For portable backup, set `LACIFY_ARCHIVE_PASSPHRASE` through a secret manager and create a `.lacify.enc` archive outside the repository. Store the archive and passphrase separately. Losing the passphrase makes the archive intentionally unrecoverable.

The `Workspace` Actor now composes the original Projects object with `workspace-tasks@1.1.0`. They share the `workspaceId` ownership and transaction boundary while retaining separate tables and typed operations. Version 1.1.0 adds task priority without rewriting the 1.0.0 files.
