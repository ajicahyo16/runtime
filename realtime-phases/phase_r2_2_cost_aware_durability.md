# Phase R2.2: Cost-Aware Event Durability

## Status

**In progress.** The contract, compiler, R2 segment path, acknowledgements, eviction-safe recovery, and local capacity evidence are implemented. Controlled staging slow-consumer evidence is still required before production use.

## Objective

Allow each generic realtime event type to select storage cost and durability semantics without introducing application-specific schemas.

## Contract

```yaml
events:
  - name: CursorMoved
    durability: ephemeral
  - name: MessageSent
    durability: segmented
    batchSize: 100
  - name: PaymentConfirmed
    durability: immediate
```

- `ephemeral` broadcasts without persistent history.
- `segmented` sends an `accepted` acknowledgement, batches events into R2, then sends a `durable` acknowledgement.
- `immediate` commits directly to Room Actor SQLite and returns a `durable` acknowledgement.
- An undeclared event defaults to `immediate` for backward compatibility.

## Implemented

- [x] Validate and deterministically normalize event durability policies.
- [x] Compile an R2 history binding and SQLite segment catalog.
- [x] Write bounded immutable JSON event segments to R2.
- [x] Distinguish accepted and durable acknowledgements.
- [x] Tell clients to retry segmented events until durable.
- [x] Replay committed segments from R2 through a bounded segment cursor.
- [x] Exercise segment write, commit acknowledgement, and replay in workerd/Miniflare.

## Remaining acceptance evidence

- [x] Prove retries are idempotent after actor eviction between accepted and durable acknowledgement.
- [x] Define immediate-only client sequencing so ephemeral and segmented traffic cannot create command gaps.
- [x] Compress segments and validate decompression limits.
- [x] Test orphan-segment recovery when R2 succeeds but catalog commit fails.
- [x] Run controlled local cost and capacity tests.
- [ ] Run a controlled staging slow-consumer network test.

## Safety boundary

`accepted` never means persisted. Clients must retain a retry buffer until `durable` is received. R2.2 must not be deployed as production durable history until the eviction and orphan-recovery gates pass.
