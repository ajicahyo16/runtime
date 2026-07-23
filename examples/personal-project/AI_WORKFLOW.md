# AI project workflow

Use this protocol whenever an AI coding agent changes the Lacify data model or operation surface.

1. The AI reads `lacify.runtime.yaml`, the relevant Actor schema, existing migrations, operation contracts, and tests.
2. The AI creates normal reviewable files. Applied migrations are never edited.
3. When the object capability is reusable, run `lacify modules`, prepare a module plan for the intended Actor, and install only its exact approved plan.
   For an installed module, run `lacify module-status`; automatically upgrade only an unchanged installation with an exact additive upgrade plan.
4. Run `node ../../bin/lacify.mjs integrate --json` to refresh the typed client, server adapter, and manifest.
5. Run `node ../../bin/lacify.mjs review --json`.
6. Inspect the repository diff plus the returned review ID, source file hashes, migration summary, operations count, and test result.
7. If anything changes, discard the old approval and create a new review.
8. Apply locally with:

   ```text
   node ../../bin/lacify.mjs apply-review --review <review-id> --approve
   ```

9. Run `node ../../bin/lacify.mjs doctor --json`.
10. To synchronize and deploy the exact reviewed source to remote Development, authenticate first and add `--remote`.
11. Use the generated adapter only from a trusted backend with `LACIFY_RUNTIME_URL` and a scoped server-side runtime credential.
12. Run `node ../../bin/lacify.mjs doctor --remote --json`, then inspect Development health and telemetry before promoting the immutable release through Staging or Production governance.
13. Before risky local data work, request explicit approval for `node ../../bin/lacify.mjs snapshot --approve`, verify the snapshot, and run an isolated restore rehearsal.
14. For off-device portability, create and verify an encrypted archive with a passphrase supplied only by the protected process environment. Restore tests must target a new directory.

The receipt contains paths, sizes, hashes, plan metadata, and test names only. It does not contain SQL source, runtime credentials, prompts, or business rows.
Snapshot SQLite files do contain business rows and must remain under the ignored `.lacify/backups/` directory or another encrypted private backup location.
Encrypted archives also contain business rows after decryption. Keep archive files and passphrases in separate protected locations and never commit either.
