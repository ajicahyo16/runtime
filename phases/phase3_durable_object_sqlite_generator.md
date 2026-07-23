# Phase 3: Business Aggregate and SQLite Generator

## Status

**Complete for the visual contract model and v1 compiler.** Phase 10 will add the file-first database-as-code interface.

## Objective

Map a Business Aggregate such as `Outlet`, `Warehouse`, or `BookingCalendar` to a Durable Object class whose instances own isolated SQLite state and execute short request-response business commands.

## Delivered

- [x] Business Aggregate designer with partition key, objects, fields, commands, and state flows.
- [x] Server-side validation and revisioned contract persistence.
- [x] Deterministic release compiler.
- [x] Generated Worker routing and Durable Object bindings.
- [x] Generated SQLite schema and aggregate-state storage.
- [x] Generated command handlers following the seven-step lifecycle.
- [x] Generated runtime manifest, Wrangler configuration, and client-facing artifacts.
- [x] Deep health covering Worker, Durable Object, and SQLite.
- [x] Runtime telemetry instrumentation that does not block business commands.

## Runtime invariant

```text
Worker (stateless routing)
  → Durable Object selected by Business Aggregate partition key
    → SQLite transaction and business rules
      → response
```

Every command follows:

```text
Wake → Validate → Execute → Persist → Update Summary → Respond → Sleep
```

## Product rules

- A Durable Object is a transactional Business Aggregate boundary, not a single row.
- Operational business data is stored in the Actor's SQLite database.
- Workers remain stateless.
- R2 is for files, not transactional state.
- Heavy asynchronous compute belongs outside the request lifecycle.
- Generated releases are content-addressed and immutable.

## Acceptance evidence

- [x] The `Outlet` aggregate compiles into a deployable Worker and SQLite-backed Durable Object.
- [x] Runtime commands persist aggregate state and return lifecycle evidence.
- [x] Deep health reports Worker, Durable Object, SQLite size, tables, and row counts.
- [x] The same verified checksum can be promoted across environments.

## Next dependency

Phase 4 makes the lifecycle understandable and testable before deployment.
