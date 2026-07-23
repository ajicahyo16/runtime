# Phase 11 live acceptance

Date: 2026-07-23

## Immutable identity

- Project: `personal-project-vault`
- Source fingerprint: `ed907f3115c4794c63b042e5b4280d7bda1d50d7b75eb74264caf8c63b0e8a30`
- Release: `release_f0c20ab1707c6008acb00d63`
- Release checksum: `f0c20ab1707c6008acb00d63ed64aa93c82db805aa84a6937dcc29f483755b1f`

## Live environments

| Environment | Deployment | Runtime | Result |
| --- | --- | --- | --- |
| Development | `deploy_f0c20ab1707c6008ac_dev` | `https://personal-project-vault-dev-runtime.ajicayo16.workers.dev` | Deep health passed |
| Staging | `deploy_f0c20ab1707c6008ac_staging` | `https://personal-project-vault-staging-runtime.ajicayo16.workers.dev` | Deep health passed |
| Production | `deploy_f0c20ab1707c6008ac_production` | `https://personal-project-vault-production-runtime.ajicayo16.workers.dev` | Deep health passed |

Production promotion used change request `change_8260f4dc-d806-4c7c-b7d9-413e1c466278`, reviewed against Production configuration revision 1.

## Acceptance results

- Local canonical validation: passed.
- Local operation fixtures: 2 passed.
- Generated TypeScript SDK compilation: passed.
- Missing runtime credential: rejected with HTTP 401.
- SDK `CreateProject`: passed.
- Same idempotency key and input: replayed without a second write.
- SDK `GetProject`: persisted row returned.
- Same record ID in another partition: `null`.
- Paginated `ListProjects`: bounded result returned.
- Runtime telemetry for all three operations: observed.
- Repository/environment drift after apply: clean.
- Synthetic result hash: `38ff3cd5a10807fc062356596cf93db2ab67af965166d9911066ed6c3fc8ba0c`.

The temporary acceptance credential was revoked after testing and Development was redeployed. No plaintext credential or business row is stored in this document.

## Phase 13 repository review

- Review: `review_26adb98f65efd3b3084f95272caeea9a10c23ee4`
- Source manifest: `0cb8498071355e514e90b2cd01d5097182590b50cc160da95f124ce895d1b5cd`
- Bound canonical files: 11
- Local operation fixtures: 2 passed
- Actor operations: 3
- Pending migrations: 0

The saved receipt contains metadata and hashes only. The existing live release was not redeployed because this acceptance review found no pending source or migration change.

## Phase 14 application integration

- Generated client fingerprint: `ed907f3115c4794c63b042e5b4280d7bda1d50d7b75eb74264caf8c63b0e8a30`
- Trusted server adapter: generated and type-safe.
- Secret-free integration manifest: generated.
- Backend project-store wrapper: generated SDK operations connected.
- Local doctor: ready; source, tests, plans, generated integration, review, Development, and MCP checks passed.
- Authenticated remote doctor: ready.
- Remote Development: `deploy_f0c20ab1707c6008ac_dev` succeeded.
- Active Development credentials: 0, intentionally, because the temporary Phase 11 acceptance credential remains revoked.

Doctor returned only credential-configuration warnings and explicitly returned no secret values or business rows. A permanent credential should be created only when a specific trusted backend is ready to receive it.

## Phase 15 local recovery

- Snapshot: `snapshot_b702d6fc-ae7c-4313-bd47-30045daa02f4`
- Actor databases: 1
- Snapshot bytes: 28,672
- Full-file checksum: matched
- SQLite integrity: passed
- Schema fingerprint: matched
- Restore rehearsal: `rehearsal_a9ec1412-19e7-4193-822f-c8e0a0d2ad37`
- Isolated temporary restore: yes
- Active Development overwritten: no
- Business rows returned by CLI: no

The snapshot database contains local Development business data and is excluded from Git. Only this sanitized metadata evidence belongs in the repository.

## Phase 16 Actor composition

- Module: `workspace-tasks`
- Module plan: `module_plan_d6b20a43fe7fbd6b9b238249723d1a851ad3cd0b`
- Target: existing `Workspace` Actor
- Actor count after installation: 1
- Object sets: Projects and Tasks
- Added migration: `0110_workspace_tasks`
- Added operations: `CreateTask`, `CompleteTask`, and `ListTasks`
- Local operation fixtures: 3 passed
- Project fingerprint: `95f6a6ae697cf8495d6bdd6f5bae9fe0c8793dc3f28ab9bce3b1d7e6f68957ee`
- Review: `review_1789ff475760d9b06eb7d64f230725005b5d8c37`
- Release: `release_7fe0ba0731d75a8253df11fe`
- Development deployment: `deploy_7fe0ba0731d75a8253_dev`
- Runtime health: passed
- Current snapshot: `snapshot_178de6a3-26df-4c7f-8c6c-41b1b7220522`
- Restore rehearsal: `rehearsal_65ef924d-d90f-4c14-a6e1-31548c0e42ab`

The extension reused the same Actor ownership boundary without sharing data or credentials with another project. Staging and Production were not changed.

## Phase 17 module upgrade

- Module: `workspace-tasks`
- From version: `1.0.0`
- To version: `1.1.0`
- Baseline customized before upgrade: no
- Upgrade plan: `module_upgrade_cfb858caf753dfa5256661c4e8c183003d95f0cd`
- Added migration: `0120_task_priority`
- Added operation: `SetTaskPriority`
- Existing module files overwritten: no
- Local operation fixtures: 4 passed
- Project fingerprint: `46a291eea7b226c471ff2246c9e73785d37555d8f070b12c026c6cec088115ed`
- Review: `review_0f89334d0a74d84d39ee005b8bde3087a1fc9efa`
- Release: `release_26180d37ac7c90824538f225`
- Development deployment: `deploy_26180d37ac7c908245_dev`
- Runtime health: passed
- Current snapshot: `snapshot_4d5441a0-2979-4637-b218-130a929df30b`
- Restore rehearsal: `rehearsal_348df063-f8d2-4ec6-8be4-d34757bfd0a2`

The installed module now reports `current`. Staging and Production were not changed.

## Phase 18 encrypted portability

- Source snapshot: `snapshot_4d5441a0-2979-4637-b218-130a929df30b`
- Archive: `archive_e96827cf8568d0b819987f6ae2d8de2a616c009c`
- Archive size: 94,207 encrypted bytes
- Cipher: AES-256-GCM
- Key derivation: scrypt
- Authentication: passed
- Workspace checksum: matched
- SQLite integrity: passed
- Schema fingerprint: matched
- Restored project fingerprint: `46a291eea7b226c471ff2246c9e73785d37555d8f070b12c026c6cec088115ed`
- Existing project overwritten: no
- Passphrase returned: no
- Business rows returned: no
- Ephemeral archive and recovered acceptance directory: deleted

The acceptance passphrase existed only in process memory. Create a permanent archive later with a passphrase you control and store the two separately.
