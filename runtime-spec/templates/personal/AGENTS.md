# Lacify personal project

- Treat every Actor as a partitioned ownership boundary.
- Add forward-only migrations; never edit an applied migration.
- Expose data only through declared parameterized operations.
- Prefer `lacify modules` and a conflict-checked module plan when a reusable object capability already exists; install only the exact approved plan into the intended Actor.
- Check `lacify module-status` before changing installed module files. Never auto-upgrade a customized installation; prepare a manual merge instead.
- Run `lacify integrate` after changing the Actor or operation surface so the backend adapter stays fingerprint-bound.
- Run `lacify review`, report its receipt ID and changed files, and wait for explicit approval before `lacify apply-review`.
- Run `lacify doctor` after apply and report blockers without printing environment values.
- Before risky local data or schema work, request approval for `lacify snapshot --approve`; verify it and rehearse recovery without inspecting or returning business rows.
- For off-device backup, read the archive passphrase only from the protected process environment. Never put it in a command argument, prompt, repository file, result, or audit event.
- In a multi-project workspace, discover peer metadata only. Mutate only the repository whose root and `LACIFY_MCP_PROJECT` match the selected context; switching projects requires an explicit new MCP configuration.
- Treat project blueprints as immutable data-free source structure. Never copy source fixtures, SQLite data, credentials, lock state, reviews, or deployments; add new project-specific tests before review.
- For blueprint v2 composition, use original Actor names for rename/partition maps, select modules explicitly, inspect every resulting file hash, and replay the exact approved parameters.
- Never place runtime credentials, customer data, or secret values in repository files or prompts.
