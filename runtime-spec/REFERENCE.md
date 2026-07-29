# Lacify Runtime File Reference v1

## Project document

The repository root contains exactly one `lacify.runtime.yaml`.

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | Yes | Must be `lacify.dev/v1`. |
| `project` | Yes | Stable lowercase project ID, 1–63 characters. |
| `runtime` | Yes | Must be `request-response` for Runtime v1. |
| `actors` | Yes | One to 64 unique `./actors/<id>/actor.yaml` references. |

Unknown fields are errors. Actor references cannot be absolute or escape the repository root.

## Actor document

Each Actor directory contains `actor.yaml` and a non-empty `migrations/` directory.

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | Yes | Must be `lacify.dev/actor/v1`. |
| `name` | Yes | Stable PascalCase Durable Object class identity. |
| `description` | No | Human description, limited to 500 characters. |
| `partitionBy` | Yes | Lower-camel-case key used to select an Actor instance. |
| `storage` | Yes | Must be `sqlite`. |
| `commands` | Yes | Unique PascalCase commands accepted by the Actor. |
| `operations` | No | Unique `./operations/<id>.operation.yaml` references compiled into typed SQL endpoints. |
| `stateMachines` | No | Explicit states and command-driven transitions. |
| `summaries` | No | Daily, monthly, or yearly derived-summary declarations. |
| `secretRefs` | No | Uppercase names only; values live in environment configuration. |

### State machine

A state machine declares:

- a unique PascalCase `name`;
- an `initial` state present in `states`;
- at least two unique states;
- transitions whose `command`, `from`, and `to` values reference declared items.

Transitions are explicit. Array position does not imply a transition.

### Summary

A summary has a lowercase SQL-safe `name`, a `period` of `daily`, `monthly`, or `yearly`, and a `sourceTable`. Phase 10 Milestone 2 will verify the source table against the resulting migration schema.

### Secret reference

`secretRefs` contain names such as `PAYMENT_API_KEY`. A repository file must never contain the corresponding value.

## Operation files

An operation has a reviewable YAML contract and one SQL statement. The YAML file uses `lacify.dev/operation/v1` and declares:

- a PascalCase `name`;
- `kind` as `command` or `query`;
- a sibling `./<id>.sql` file;
- zero to 64 typed `input` fields;
- `result.mode` as `none`, `one`, `optional`, or `many`;
- explicit typed `result.fields` for every non-`none` result;
- `result.maxRows` between 1 and 100 when mode is `many`;
- optional cursor pagination for `many` results.

Input types are `string`, `integer`, `number`, and `boolean`. `partitionId`, `now`, and `commandId` are runtime-owned and cannot be declared as user inputs.

Result fields use the same scalar types and may declare `nullable: true`. Runtime responses contain only these declared fields; extra SQLite columns are not returned. The generated TypeScript client creates exact input, row, command-response, optional-result, and list-result types from this contract.

Paginated results declare `cursorField`, `defaultPageSize`, and `maxPageSize`. Their SQL binds runtime-owned `:cursor` and `:pageSize`, orders by the declared cursor field, and returns:

```json
{
  "items": [],
  "nextCursor": null
}
```

The runtime fetches at most one row beyond the requested page to determine `nextCursor`. Page size can never exceed the operation's declared maximum.

Operation SQL contains exactly one statement and uses named `:parameter` bindings. Every declared input must be used and every referenced input must be declared. Every operation must bind `:partitionId`.

Queries support only `SELECT`. Commands support `INSERT`, `UPDATE ... WHERE`, and `DELETE ... WHERE`. DDL, unbounded writes, positional parameters, and access to `_lacify_*` or `sqlite_*` objects are rejected. Clients submit operation names and values; they never submit SQL.

## Migration files

Migration filenames use:

```text
NNNN_lowercase_name.sql
```

The initial bounded dialect supports:

- `CREATE TABLE`
- `CREATE INDEX`
- `CREATE UNIQUE INDEX`
- `ALTER TABLE <name> ADD COLUMN`
- `INSERT INTO` for explicit data migrations
- `UPDATE ... WHERE ...` for bounded data migrations

The initial validator rejects:

- `DROP` and `TRUNCATE`
- `PRAGMA`, `ATTACH`, and `DETACH`
- `VACUUM` and `REINDEX`
- triggers and virtual tables
- unbounded `UPDATE`
- statements outside the declared dialect
- files larger than 1 MiB

Every statement is terminated with `;`. Editing an applied migration will become an error when the Milestone 2 registry is introduced.

## Development seed data

An Actor may contain:

```text
actors/<actor-id>/seeds/development.sql
```

This optional file supports only deterministic `INSERT` and bounded `UPDATE ... WHERE` statements. DDL, deletes, unbounded updates, and Lacify/SQLite internal tables are rejected.

Development seeds are validated but deliberately excluded from:

- the project fingerprint;
- immutable release manifests and Worker artifacts;
- remote Development apply payloads;
- Staging and Production.

`lacify dev` reapplies the seed whenever its in-memory databases reset. A `tests/*.operation.json` fixture uses it only when `useSeedData` is explicitly `true`.

## Local operation tests

`lacify test` reads deterministic `tests/*.operation.json` files. Each fixture selects an Actor and partition and runs ordered steps with:

- `operation` and typed `input`;
- optional `page` and `idempotencyKey`;
- `expectData` for successful results; or
- `expectError.code` for an expected safe failure.

Unexpected failures identify the fixture, Actor, operation, step, operation definition, SQL file, and rollback recovery state. Raw SQLite errors and SQL source are not printed.

`lacify dev` serves the same command and query routes on localhost. Valid file changes trigger validation, reset the in-memory Actor databases, reapply migrations and Development seeds, and increment the local runtime generation. Invalid changes make local health return diagnostics until the files validate again.

## MCP operation authoring

The MCP server exposes safe Actor data-model metadata compiled from migrations in an ephemeral SQLite database. It includes tables, columns, indexes, a schema fingerprint, and declared operation metadata. It excludes business rows, Development seed data, and secret values.

`validate_operation_proposal` accepts proposed operation YAML and SQL and validates them entirely in memory. It checks the canonical contract, SQL safety, parameters, and compatibility with the Actor schema without writing repository files or mutating remote state.

`plan_operation_release` returns bounded operation names, routes, input field names, result contracts, and fingerprints. It does not return SQL source or business rows. `run_local_operation_tests` executes repository fixtures only against isolated local SQLite databases, and `generate_typed_client` creates deterministic TypeScript output from the validated fingerprint.

A remote Development execution test requires two calls:

1. `plan_development_operation_test` creates an immutable plan that binds the current project and operation fingerprints and hashes of the partition, input, page, expected result, and idempotency key.
2. `execute_development_operation_test` requires the exact unchanged plan, an authorized owner/admin/developer, and `approved: true`.

Remote execution is limited to the succeeded Development runtime URL reported by the Control Plane on a trusted HTTPS host. Its response and audit event contain hashes and bounded execution metadata, not input values, partition values, expected data, or returned business rows.

## Runtime application credentials

Use `lacify credential-rotate development` to issue a replacement credential
for the current canonical operation surface. The command requires explicit
approval and an absolute token-file path outside the repository. It never
prints the plaintext token. Credential activation remains governed by a
subsequent Development ship, and revocation should happen only after the new
backend secret passes a smoke test.

`lacify ship development` performs an operation-level capability preflight
when active credentials exist. Missing capability coverage blocks the release
before deployment and reports bounded `Actor.Operation` metadata only.

The generated runtime exposes `GET /__lacify/access`. It requires the scoped
application bearer token and returns only environment, deployment identity,
and allowed operation names. `lacify doctor --remote` uses this endpoint for
an end-to-end authentication and coverage check without executing an Actor
operation or returning business rows.

Operation routes require a `Bearer lacify_runtime_*` credential. A credential belongs to one workspace, project, and environment and contains one or more Actor capabilities:

```json
{
  "actor": "Outlet",
  "operations": ["GetOrder", "PlaceOrder"],
  "rateLimitPerMinute": 60,
  "maxPayloadBytes": 32768
}
```

The Control Plane validates every operation name against the current contracts, stores only the token hash, and returns the plaintext token once. Active hashes and capabilities are copied into an environment-specific secret policy during deployment. Credential creation and revocation therefore take effect on the next deployment of that environment.

The Worker authenticates and authorizes before routing. It enforces the payload bound, removes any caller-provided internal identity headers, and passes a deployment-salted identity hash and bounded rate policy to the Actor. The Actor enforces the rate limit in partition-local SQLite.

Operation audit rows contain caller hash, operation, kind, outcome, HTTP status, and timestamp only. Telemetry may contain the same caller hash plus the existing partition hash and execution metrics. Neither channel stores the token, input, output, SQL, partition value, or business rows.

## Normalization and fingerprints

The project fingerprint covers:

- the normalized project document;
- normalized Actor definitions;
- ordered migration IDs;
- normalized LF migration content.
- normalized operation definitions and their normalized LF SQL content.

Object keys and semantically unordered collections are sorted. Explicit file migration order remains filename order. Any semantic change produces a different SHA-256 fingerprint.

## Diagnostics

Diagnostics contain:

```json
{
  "file": "/absolute/project/actors/outlet/actor.yaml",
  "path": "partitionBy",
  "line": 3,
  "code": "identifier",
  "message": "Partition key must be a lower-camel-case identifier."
}
```

Validation never returns secret values or business records.

## Personal workspace manifest

A directory containing several independent projects may define:

```yaml
version: lacify.dev/workspace/v1
name: personal-platform
projects:
  - path: crm-personal
  - path: project-manager
```

Each path is relative to the workspace root and must resolve to a contained directory with a valid `lacify.runtime.yaml`. Canonical project IDs and real paths must be unique. Absolute paths, traversal, symlink escapes, and more than 128 entries are rejected.

The workspace contract contains no business schema or rows. It supports metadata-only project discovery, local readiness diagnostics, and module-version comparison. Actors with the same name in different projects remain unrelated ownership and SQLite boundaries.

`workspace-mcp-config` selects one exact project for an MCP process. `LACIFY_MCP_PROJECT` must match the repository project ID, while `LACIFY_WORKSPACE_ROOT` only enables peer discovery. Workspace discovery never switches the mutation target.

## Reusable project blueprint

An immutable blueprint is stored in the workspace:

```text
.lacify/blueprints/<blueprint-name>/<semantic-version>/
  blueprint.json
  files/
    lacify.runtime.yaml
    actors/...
```

`blueprint.json` binds its source project/fingerprint, Actor metadata, current module provenance, canonical file hashes, exclusions, and required `project` parameter into a blueprint fingerprint.

Only canonical project, Actor, migration, and typed operation source is exported. Data-changing migrations are rejected. Development seeds, operation fixtures, runtime databases, credentials, environment state, module installation history, reviews, generated output, and deployment state are excluded.

Materialization changes the runtime project ID, validates the projected fingerprint in an isolated directory, creates a fresh empty lock, adds current AI instructions and a test-authoring guide, and registers the completed direct-child project path. It does not apply or deploy the project. Blueprint versions and existing targets are never overwritten.

### Blueprint v2 composition

New exports use `lacify.dev/blueprint/v2`. The manifest additionally binds:

- each source Actor name to its canonical `actor.yaml`;
- each current module to an `Actor:module` selector;
- the migration and operation files owned by that module;
- the Actor commands and operation references contributed by that module;
- typed maps for Actor renames and partition keys;
- an optional explicit module-selector set.

An omitted module set retains all source modules. An empty set removes every optional module. Removal deletes the module-owned canonical files and its Actor patch entries. Actor and partition transformations are keyed by the original Actor name.

After transformation, Lacify validates the complete project, executes every retained migration in isolated in-memory SQLite, and prepares every retained operation SQL statement against that schema. The normalized parameters, projected fingerprint, and all output file hashes are part of the plan ID.

Blueprint v1 remains immutable and supported, but only its project-ID parameter is composable.
