# Lacify Runtime v1 — AI authoring guide

Use Lacify as database-as-code for request-response business aggregates.

1. Read `lacify.runtime.yaml` and every referenced `actor.yaml`.
2. Treat each Actor as one transactional and partitioned ownership boundary.
3. Put durable schema changes in a new, forward-only `NNNN_name.sql` migration.
4. Put commands, operation references, lifecycle transitions, summaries, and secret names in `actor.yaml`.
5. Put typed command/query contracts in `operations/*.operation.yaml` and parameterized SQL in their sibling `.sql` files.
6. Never put secret values, customer records, credentials, or production identifiers in generated files.
7. Never edit an applied migration. Add the next migration instead.
8. Run `lacify validate`, then `lacify plan --env development`.
9. Run `lacify test` and use `lacify dev` when local integration is useful.
10. Keep deterministic sample rows only in `seeds/development.sql`; never put real customer data there.
11. Show the file diff and plan. Do not call apply without explicit user approval.
12. Use `lacify apply --env development --approve` only for the exact reviewed fingerprint and plan.
13. Promote the resulting immutable release through Lacify governance; never bypass Staging or Production controls.

## MCP operation-authoring flow

An MCP-compatible agent should use this bounded sequence:

1. Read the Actor with `get_actor_schema` and `get_actor_data_model`. The data model contains table, column, index, and operation metadata, never rows or seed values.
2. Draft the operation YAML and SQL, then call `validate_operation_proposal`. This validation is in memory and does not write files or mutate a remote environment.
3. After validation succeeds, write the reviewable files, add the Actor operation reference, and run `validate_project_files` and `run_local_operation_tests`.
4. Call `generate_typed_client` and `plan_operation_release` to inspect deterministic client output and bounded release metadata.
5. Show the file diff and plan to the user. Do not apply or execute remotely without explicit approval.
6. If a remote Development execution test is requested, call `plan_development_operation_test` first. Execute only the exact unchanged plan with `execute_development_operation_test` after explicit approval.

Remote test plans bind the project and operation fingerprints plus hashes of the partition, input, pagination, expected result, and idempotency key. Returned results and audit records contain bounded metadata and hashes, not business rows or raw input.

## Workspace and blueprint flow

When `LACIFY_WORKSPACE_ROOT` is configured:

1. Use `list_workspace_projects` and `get_workspace_module_matrix` for metadata-only discovery.
2. Keep all normal mutation tools bound to the repository and `LACIFY_MCP_PROJECT` selected for this MCP process.
3. Use `list_project_blueprints` and `get_project_blueprint` to inspect immutable versions, hashes, provenance, and exclusions.
4. Call `plan_project_from_blueprint` with a new project ID and inspect every generated file hash.
5. Create only after the user approves the exact plan. `create_project_from_blueprint` also requires the exact blueprint fingerprint and an MCP context matching the blueprint source project.
6. Add new project-specific operation fixtures, then use the normal integrate, review, and approved apply workflow.

Blueprints reuse canonical schema and operation source only. Never add source business rows, Development seeds, fixtures, SQLite files, credentials, environment state, module installation history, reviews, generated output, releases, or deployments to a blueprint.

For a composable v2 blueprint, use original Actor names as the keys in `actorRenames` and `partitionKeys`. Omit `modules` to keep all source modules, pass an empty array to keep none, or pass explicit `Actor:module` selectors. Inspect the resulting Actor metadata, selected modules, projected fingerprint, and file list before requesting approval.

## Application credential rules

- Request the smallest environment and operation allowlist required by the application.
- Keep `rateLimitPerMinute` and `maxPayloadBytes` at the lowest practical values.
- Treat the returned `lacify_runtime_*` value as a server-side secret; it is shown only once.
- Redeploy the target environment after credential creation or revocation so its immutable access policy is current.
- Pass the token to the generated SDK from a server-side environment variable. Never commit it, place it in operation files, or expose it through browser build variables.
- For an approved MCP Development test, configure `LACIFY_RUNTIME_APPLICATION_TOKEN`; never include the token in a prompt or tool arguments.

The stateless Worker routes commands. Business rules and SQLite state belong to the Actor. Runtime v1 does not support WebSockets or long-lived collaborative sessions.

## Prompt examples

- “Add an `Outlet` Actor partitioned by `outletId`, with `OpenShift`, `PlaceOrder`, and `CloseShift` commands. Create only reviewable Lacify YAML and forward-only SQL files, then validate and plan without applying.”
- “Add an indexed `status` column to the Warehouse Actor. Do not edit applied migrations; create the next numbered migration.”
- “Add an Order lifecycle from `Open` to `Paid` through `CapturePayment`, and validate that every transition references a declared command.”
- “Add a daily `sales_daily` summary sourced from `orders`; keep aggregation inside the owning Actor.”
- “Reference `PAYMENT_API_KEY` by name. Do not request, read, or write its value.”
- “Add a typed `PlaceOrder` command operation and `GetOrder` query using named parameters. Scope both to `:partitionId`; do not expose arbitrary SQL.”
- “Add a paginated `ListOrders` query with explicit result fields, an `id` cursor, and a maximum page size of 50. Bind `:cursor` and `:pageSize` and order by `id`.”
- “Add deterministic local seed orders and operation fixtures for success, invalid input, pagination, and an expected conflict. Keep all seed data Development-only.”

Machine-readable diagnostics use `file`, `line`, `path`, `code`, and `message`, allowing an agent to patch the exact source file and re-run validation.
