# Phase R3.4 — Production Safety and Operations

## Status

**Complete.**

## Goal

Keep event delivery bounded, observable, recoverable, and inexpensive when a
downstream service is slow or unavailable. This phase does not add a new
authoritative data store and does not change Runtime v1 request-response
semantics.

## Operational contract

### Router recovery

- A failed delivery remains `pending` with its exact checksummed envelope.
- Durable Object alarms retry at most 16 due items per invocation.
- Retry delay uses bounded exponential backoff.
- Successful recovery marks the same event delivered; it never replays the
  source business operation.
- Delivered router receipts are compacted after seven days in bounded batches.

### Backpressure and circuit breaking

- Event IDs are deterministically distributed over 16 shards per target.
- Each shard accepts at most 256 pending envelopes.
- A full shard returns `429 router_backpressure`; the authoritative Runtime
  outbox retains the event and retries it.
- Three consecutive target failures open a persisted circuit.
- Circuit cooldown starts at 10 seconds and is capped at five minutes.
- A success resets that target circuit within the shard.

### Health and budget metadata

- Router health reports configured layers and optionally one deterministic
  event shard.
- Deep health probes Reporting and Realtime through service bindings.
- Shard health reports counts, attempts, oldest pending time, capacity, and
  circuit state without event payloads.
- Realtime health reports declared connection, persistent-event, and frame
  budgets without room data.
- Runtime deep health includes the Event Router layer when emits are configured.

### Deployment preflight

Compilation emits a metadata-only `deployment-preflight.json`. The generated
router exposes an exact-approval preflight endpoint that verifies required
bindings, secrets, and downstream health without remote mutation.

### Retention

- Immediate room history performs bounded SQLite compaction every 128 durable
  events.
- Committed R2 segments older than room retention are deleted together with
  their SQLite catalog rows in batches of 16.
- Generated R2 lifecycle files are safety nets and are metadata-only; applying
  them remains a reviewed deployment action.
- Server events older than the room retention window fail closed.

## Acceptance

- [x] Recover pending router delivery through a Durable Object alarm.
- [x] Enforce per-shard pending capacity.
- [x] Persist and expose bounded circuit state.
- [x] Keep operational health payload-free.
- [x] Produce exact-approval deployment preflight metadata.
- [x] Produce reviewed R2 lifecycle policy artifacts.
- [x] Compact immediate and segmented room history in bounded batches.
- [x] Pass full repository tests, build, security check, audit, and diff check.

## Deliberate limits

- Preflight and lifecycle artifacts do not mutate Cloudflare resources.
- Metrics are operational counters, not centralized billing truth.
- Free-tier and scale claims still require staged traffic and billing evidence.
- Cloud Run remains an optional future compute adapter, not a core dependency.
