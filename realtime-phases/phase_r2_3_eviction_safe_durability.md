# Phase R2.3: Eviction-Safe Durability and Recovery

## Status

**Complete.** Correctness and local recovery gates pass. No production scale or cost claim is made by this phase.

## Objective

Make segmented R2 history recoverable across retries and partial storage failures without converting the hot path back into one SQLite write per event.

## Recovery state machine

```text
accepted in memory
       |
       v
SQLite pending intent (one row per segment)
       |
       v
R2 gzip object
       |
       v
SQLite committed catalog
       |
       v
durable acknowledgement
```

The pending intent retains the bounded uncompressed body until R2 storage and catalog commit both succeed. A retry can therefore complete an interrupted segment without relying on actor memory.

## Implemented

- [x] Derive deterministic segment keys from ordered event IDs.
- [x] Persist one pending recovery intent per segment.
- [x] Recover a missing R2 object from the pending body.
- [x] Commit and clear the pending body only after R2 succeeds.
- [x] Deduplicate committed event IDs through the segment catalog after reconnect.
- [x] Keep ephemeral and segmented traffic outside immediate command sequencing.
- [x] Compress R2 segments with gzip.
- [x] Store and verify SHA-256 checksums.
- [x] Enforce compressed and declared uncompressed replay bounds.
- [x] Verify reconnect retry creates no duplicate R2 object.
- [x] Restart persisted workerd after accepted acknowledgement and prove client retry recovery.
- [x] Inject and recover failure after pending intent, after R2 put, and after catalog commit.
- [x] Verify concurrent reconnect recovery converges to one R2 object.
- [x] Prevent writer-created orphan objects by committing the recovery intent before every R2 put.
- [x] Recover bounded pending intents automatically when a Room Actor accepts a new connection.

Out-of-band R2 objects created manually or by legacy software are an operations inventory concern. Staged cost, latency, eviction, and slow-consumer load tests remain part of the scale-validation phase.

## Client rule

`clientSeq` is authoritative only for `immediate` events. Ephemeral and segmented events use globally unique `eventId` values and must remain in the client retry buffer until a `durable` acknowledgement is received.
