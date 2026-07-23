# Phase 11: Executable Data Operations

## Status

**Complete — all seven milestones passed, including governed live acceptance.**

## Objective

Make Lacify databases useful from real personal projects by compiling reviewable, typed SQL operation files into safe Actor-local command and query endpoints.

Phase 10 lets an AI create schemas and forward-only migrations. Phase 11 adds the missing execution contract:

```text
application or AI-authored project
  → typed generated client
    → stateless Worker route
      → declared Actor operation
        → parameterized SQL inside the owning Durable Object
          → bounded typed result
```

Lacify does not expose arbitrary remote SQL. Every operation is a version-controlled contract, validated before release, scoped to one Actor partition, and compiled into the immutable runtime.

## Canonical repository layout

```text
actors/
  outlet/
    actor.yaml
    migrations/
      0001_initial.sql
    operations/
      place-order.operation.yaml
      place-order.sql
      get-order.operation.yaml
      get-order.sql
```

An Actor references operation definitions:

```yaml
operations:
  - ./operations/place-order.operation.yaml
  - ./operations/get-order.operation.yaml
```

An operation definition describes the public contract:

```yaml
version: lacify.dev/operation/v1
name: PlaceOrder
kind: command
sql: ./place-order.sql
input:
  orderId:
    type: string
    required: true
  total:
    type: integer
    required: true
result:
  mode: one
```

The SQL file contains only parameterized SQL:

```sql
INSERT INTO orders (id, outlet_id, total, status, created_at, updated_at)
VALUES (:orderId, :partitionId, :total, 'Confirmed', :now, :now)
RETURNING id, total, status;
```

`:partitionId`, `:now`, and `:commandId` are runtime-owned parameters. User input cannot override them.

## Product and safety rules

- Operations execute only inside the Actor Durable Object that owns the SQLite database.
- Runtime routes select operations from the immutable compiled manifest; clients cannot submit SQL.
- SQL identifiers are static. Runtime values use named parameters.
- Command operations may write only through bounded `INSERT`, `UPDATE ... WHERE`, or `DELETE ... WHERE`.
- Query operations are read-only and return a bounded number of rows.
- Internal `_lacify_*` and `sqlite_*` objects cannot be accessed by authored operations.
- Input values are validated by type and size before SQL execution.
- Actor partition identity comes from the route and is bound as `:partitionId`.
- A command and its lifecycle/state updates execute in one Durable Object transaction.
- Result payloads are bounded; telemetry and audit data never contain returned business rows.
- Production still receives only immutable, verified releases through governed promotion.

## Milestone 1 — Canonical operation specification

### Work

- [x] Define and version `operation.yaml`.
- [x] Add Actor operation references and strict repository path rules.
- [x] Define command and query SQL dialects.
- [x] Define named input parameters, runtime-owned parameters, and result modes.
- [x] Include normalized operation definitions and SQL in the project fingerprint.
- [x] Add JSON Schema and human-readable reference documentation.
- [x] Add representative command and query fixtures.

### Acceptance criteria

- [x] Equivalent operation files produce the same project fingerprint.
- [x] Unknown fields, missing files, duplicate operations, and invalid command references fail with file context.
- [x] Undeclared parameters and unused declared inputs are rejected.
- [x] Query operations cannot mutate data.
- [x] Command operations cannot execute DDL, unbounded updates/deletes, or access Lacify internal tables.
- [x] Runtime-owned parameters cannot be declared or overridden by user input.

### Completion evidence

- `runtime-spec/schemas/operation.schema.json` defines the strict versioned operation contract.
- The canonical loader validates Actor references, sibling SQL files, command references, parameters, bounds, paths, and deterministic normalization.
- The project fingerprint now covers normalized operation definitions and SQL.
- The POS fixture includes `PlaceOrder` and `GetOrder` operation contracts plus deterministic command/query tests.
- Validation tests cover ordering, fingerprint changes, unknown fields, missing files, duplicate names, unsafe statements, internal tables, parameter drift, and runtime-owned parameters.

### Implementation head start for later milestones

- The Cloudflare compiler embeds operation checksums, parameterized SQL, input validation, result bounds, query routes, idempotency receipts, and telemetry-safe operation names.
- The generated TypeScript client exposes typed operation inputs, command/query methods, and idempotency headers.
- The local runtime executes operations transactionally; `lacify test` runs repository fixtures and `lacify dev` serves Actor-compatible local routes.
- MCP exposes bounded operation contracts and deterministic typed-client generation without business rows.

## Milestone 2 — Actor-local operation engine

- [x] Compile declared SQL into immutable Durable Object operation handlers.
- [x] Validate input type, required fields, field count, and encoded size.
- [x] Bind all SQL values without string interpolation.
- [x] Execute commands and lifecycle changes atomically.
- [x] Enforce row and response-size limits.
- [x] Return stable validation, conflict, and execution error envelopes.
- [x] Add idempotency keys for command retries.

### Completion evidence

- Compiled commands run business SQL, aggregate state, lifecycle events, summaries, and idempotency receipts inside one SQLite-backed Durable Object `transactionSync`.
- Operation inputs are limited to declared scalar fields, 64 fields, 64 KiB encoded input, and bounded string/number values.
- Authored `:parameter` bindings compile to positional SQLite bindings; input never becomes an SQL identifier or source fragment.
- Results enforce `none`, `one`, `optional`, and `many` cardinality, a maximum of 100 rows, and a 256 KiB encoded response.
- Error envelopes expose stable codes and safe messages while suppressing raw SQLite errors and SQL text.
- Idempotency receipts bind operation, key, and normalized input hash. Identical retries replay the stored response; different input returns `idempotency_conflict`.
- Runtime execution tests prove atomic rollback, conflict redaction, bounded query failure, partition isolation, idempotent replay, and serialized concurrent version changes.

## Milestone 3 — Typed queries and generated SDK

- [x] Add query routes that remain partition-scoped.
- [x] Generate TypeScript input and result types.
- [x] Generate typed command and query methods.
- [x] Support one, optional, many, and no-result modes.
- [x] Add pagination for bounded list queries.
- [x] Generate deterministic SDK output from the project fingerprint.

### Completion evidence

- Operation contracts declare an explicit allowlist of typed result fields; undeclared SQLite columns are removed from responses.
- Runtime result validation covers string, integer, number, boolean, nullable values, cardinality, row count, and encoded size.
- Generated TypeScript includes exact input, row, command-response, optional-result, array-result, and paginated-result types.
- Generated command and query methods no longer default operation responses to `unknown`.
- Cursor pagination binds runtime-owned `:cursor` and `:pageSize`, requires deterministic cursor ordering, fetches only one look-ahead row, and enforces a maximum page size of 100.
- The generated SDK passes strict standalone TypeScript compilation.
- Runtime tests cover field projection, result type mismatch, one/optional/many/none modes, two-page cursor traversal, and cross-partition query isolation.

## Milestone 4 — Local development and testing

- [x] Execute operations against the local SQLite runtime.
- [x] Add `lacify test` with fixture input and expected output files.
- [x] Add `lacify dev` for a local Actor-compatible HTTP surface.
- [x] Explain failed validation and SQL constraints with file and operation context.
- [x] Add deterministic seed data that is never promoted as Production data.

### Completion evidence

- `lacify test` runs ordered command/query fixtures against isolated in-memory SQLite databases with `expectData` and `expectError.code`.
- `lacify dev` serves Actor-compatible command and query routes, reports generation/fingerprint health, watches repository files, and safely resets local databases after a valid reload.
- Invalid hot reloads return bounded file diagnostics and HTTP 503 without partially loading the invalid contract.
- Local operation failures use stable codes, redact raw SQLite/SQL detail, identify fixture, Actor, operation definition, SQL file, step, and confirm transaction rollback.
- Optional `actors/<actor-id>/seeds/development.sql` files support only deterministic insert and bounded update statements.
- Development seeds are validated and reapplied locally, but are excluded from project fingerprints, Control Plane contracts, immutable releases, remote Development, Staging, and Production.
- Tests prove seed changes do not alter deployable fingerprints, seed content does not enter Control Plane contracts, watcher reload reapplies changed seeds, invalid files degrade local health, and expected-error fixtures remain deterministic.

## Milestone 5 — MCP operation authoring

- [x] Expose operation schemas and safe table metadata to MCP.
- [x] Add tools to validate operation files and generate typed clients.
- [x] Let an AI propose commands and queries without remote mutation.
- [x] Return bounded execution plans without business rows.
- [x] Require explicit approval for remote Development execution tests.

### Completion evidence

- MCP exposes per-Actor table, column, index, schema-fingerprint, and operation metadata from an ephemeral migration-only SQLite database. It excludes rows, Development seeds, and secret values.
- `validate_operation_proposal` validates proposed YAML and SQL entirely in memory, prepares the statement against the Actor schema, and returns diagnostics, fingerprints, and suggested file paths without writing files or calling a remote service.
- `generate_typed_client`, `run_local_operation_tests`, and `plan_operation_release` provide deterministic client generation, isolated fixture execution, and bounded release metadata without returning business rows or SQL source.
- Remote Development operation tests use a two-step plan and execute flow. The plan binds the project, operation, partition, input, pagination, expected result, and idempotency key by hash.
- Execution requires an authorized owner, admin, or developer, explicit approval, and the exact unchanged plan. It accepts only a succeeded trusted Development runtime URL and returns hashes and bounded metadata rather than business payloads.
- Control Plane contract validation independently preserves and validates operations, rejecting undeclared commands, query mutation, unsafe writes, internal tables, invalid parameters, and invalid pagination.
- MCP tests cover safe metadata, proposal validation, local fixtures, approval enforcement, replay protection, exact approved execution, result redaction, audit redaction, and Viewer restrictions.

## Milestone 6 — Runtime access protection

- [x] Add application authentication and Actor-operation capability checks.
- [x] Bind callers to workspace, project, environment, Actor, and allowed operations.
- [x] Add per-operation rate limits and payload limits.
- [x] Redact sensitive input and output fields from logs, telemetry, and errors.
- [x] Audit operation identity and outcome without business payloads.

### Completion evidence

- The Control Plane issues `lacify_runtime_*` application credentials once, stores only their SHA-256 hashes, scopes them to one workspace, project, and environment, and supports explicit revocation.
- Every credential declares an allowlist of Actor operations plus a per-minute request limit and maximum payload size. Unknown Actors, undeclared operations, duplicate capabilities, unsafe limits, and excessive lifetimes are rejected.
- Deployment embeds only active credential hashes and bounded capabilities in an environment-specific secret policy. A revoked or newly created credential requires redeployment so the immutable runtime policy cannot drift.
- The generated Worker denies missing, malformed, expired, and unauthorized credentials before Durable Object routing. It strips caller-supplied internal identity headers and replaces them with deployment-bound hashes.
- Payload size is checked before command JSON parsing and again against the operation capability. Durable Object SQLite counters enforce the credential-and-operation rate limit.
- Durable Objects require the trusted internal caller identity and store operation, kind, outcome, status, and time in `_lacify_operation_audit`; no input, output, partition value, SQL, token, or business row is recorded.
- Runtime telemetry contains only a deployment-salted caller identity hash, a partition hash, operation identity, outcome, status, timing, and bounded SQLite metadata.
- The generated TypeScript SDK sends the scoped Bearer credential. MCP remote Development tests read it from `LACIFY_RUNTIME_APPLICATION_TOKEN`, never from the immutable plan or audit record.
- Regression tests cover authentication, operation denial, payload limits, rate limits, audit redaction, capability validation, one-time credential storage, telemetry caller hashing, and authenticated MCP execution.

## Milestone 7 — End-to-end personal-project acceptance

- [x] Create a real sample application repository.
- [x] Ask an AI agent to add a table, command, and query as reviewable files.
- [x] Validate, test, plan, and apply to Development.
- [x] Use the generated client to create and read Actor-owned data.
- [x] Verify partition isolation, idempotency, persistence, telemetry, and drift.
- [x] Promote the exact immutable release through the existing governed path.

### Completion evidence

- `examples/personal-project` is a repository-shaped `personal-project-vault` sample with one `Workspace` Actor, an additive `projects` migration, `CreateProject`, `GetProject`, and paginated `ListProjects` operations, deterministic tests, and a generated TypeScript SDK.
- Local validation accepted fingerprint `ed907f3115c4794c63b042e5b4280d7bda1d50d7b75eb74264caf8c63b0e8a30`; both operation fixtures passed and the generated SDK compiled to executable JavaScript.
- The Control Plane compiled and verified immutable release `release_f0c20ab1707c6008acb00d63`.
- A temporary one-day Development credential was scoped to the three `Workspace` operations. The live runtime rejected an unauthenticated request, while the generated SDK successfully created, replayed, read, isolated, and listed a synthetic project record.
- Live acceptance confirmed persistence, idempotent replay, cross-partition isolation, bounded pagination, telemetry ingestion, and clean repository/environment drift.
- The temporary acceptance credential was revoked and Development was redeployed. The Control Plane reports zero active credentials for the sample.
- The exact same release passed deep health checks in Development, Staging, and Production after an audited change request and configuration-bound approval.
- Live runtime URLs and sanitized acceptance details are recorded in `examples/personal-project/ACCEPTANCE.md`.

## Definition of done

Phase 11 is complete when an AI coding agent can add a schema migration plus typed command and query files, the user can review and apply them, and a normal application can safely write and read the Actor-owned SQLite data through a generated client. No endpoint accepts arbitrary SQL, no operation crosses an Actor partition, and Production remains governed.

## Out of scope

- PostgreSQL wire compatibility.
- A public SQL console against runtime business data.
- Cross-Actor joins or multi-partition transactions.
- Unbounded exports or analytics queries.
- Automatic Production deployment.
- User-authored JavaScript running inside the runtime.
