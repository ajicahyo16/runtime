# Phase R3.2: Reporting Actor and Reconciliation

## Status

**Complete.** Contract, compiler, projection, rebuild, reconciliation, isolation, rollback, and full repository gates pass. Production deployment and scale evidence remain later phases.

## Objective

Build isolated, rebuildable reporting projections from transactional outbox events without turning reports into the authoritative business ledger.

## Contract

```yaml
emits:
  - event: OrderPlaced
    target: reporting
    durability: immediate
    fields:
      - total
      - status
      - sequence
    reporting:
      keyField: $partitionKey
      sequenceField: sequence
      dimensions:
        - status
      measures:
        - field: total
          aggregate: sum
```

`keyField` may use the source partition or an explicitly emitted result field, allowing store-level or organization-level projections.

## Implemented

- [x] Validate bounded reporting keys, dimensions, numeric measures, and optional integer sequence fields.
- [x] Include deterministic projection metadata in transactional outbox envelopes.
- [x] Compile an isolated Reporting Worker and SQLite-backed `ReportingActor`.
- [x] Partition reporting state by project, environment, and reporting key.
- [x] Deduplicate delivery by event ID.
- [x] Apply event ledger and daily measure projection atomically.
- [x] Detect source sequence gaps without rejecting late commutative measures.
- [x] Expose bounded summary queries with explicit event and date range.
- [x] Expose metadata-only reconciliation status without business payloads.
- [x] Require exact approval for a deterministic full projection rebuild.
- [x] Rebuild projections and sequence gaps from the immutable reporting event ledger.
- [x] Roll back invalid projection values without recording the event.
- [x] Verify isolation between independent reporting keys.

- [x] Pass full test, build, security, and diff gates.

## Safety boundary

Reporting rows are derived data. Payments, orders, inventory movements, and other authoritative facts remain owned by Runtime v1 business Actors. A reporting failure or gap never changes a committed business transaction.
