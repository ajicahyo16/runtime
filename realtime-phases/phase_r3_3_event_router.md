# Phase R3.3 — Event Router and Deployment Wiring

## Status

**Complete.**

## Outcome

Runtime v1 operations can publish transactional outbox events to a separate,
authenticated Event Router without changing request-response semantics. The
router delivers only declared targets:

- `realtime` to the authenticated internal endpoint of a Realtime Runtime;
- `reporting` to an isolated, rebuildable Reporting Actor;
- `archive` to an immutable R2 event path.

## Contract

Realtime emits declare a deterministic destination:

```yaml
emits:
  - event: OrderPlaced
    target: realtime
    durability: immediate
    fields: [id, total]
    realtime:
      roomClass: store
      roomField: $partitionKey
```

`roomField` is either `$partitionKey` or a declared result field. Unknown
routing fields, undeclared result fields, and invalid room identifiers fail
validation.

## Security and reliability invariants

- Runtime signs `timestamp.body` with HMAC-SHA-256.
- Router rejects invalid signatures and timestamps outside a 60-second window.
- Event envelopes are limited to 256 KiB.
- Target names are allowlisted; arbitrary URLs are never accepted.
- Router shards delivery state by target and event ID hash.
- Each shard stores checksum, delivery status, attempts, and bounded error code
  in private Durable Object SQLite.
- Reusing an event ID with different content fails closed.
- A delivered event returns idempotent conflict and is not delivered twice.
- Failed targets remain pending so the Runtime outbox can retry.
- Runtime outbox remains the source of retry and dead-letter policy.
- Sink secrets are carried only as Cloudflare secrets; generated artifacts
  include names and equality requirements, never values.
- Public WebSocket credentials cannot call the server-event endpoint.

## Deployment artifacts

For a release that emits events, compilation adds:

- `event-router.js`
- `wrangler.event-router.jsonc`
- `deployment-secrets.json`
- `LACIFY_EVENT_SINK` service binding on the request-response Runtime

Target-specific service and R2 bindings are generated only when used.

Realtime releases expose `/v1/internal/events`, authenticated by
`LACIFY_REALTIME_SINK_SECRET`. Accepted events enter the same Room Actor
ordering boundary as WebSocket traffic. Immediate events are persisted before
broadcast; segmented events return retryable failure until the R2 segment is
durable; ephemeral events broadcast without persistence.

## Acceptance evidence

- [x] Realtime routing metadata validates deterministically.
- [x] Runtime outbox persists resolved routing and signs every attempt.
- [x] Router rejects invalid signature, stale timestamp, invalid target, and
  conflicting event ID.
- [x] Router retries failed target delivery and deduplicates delivered events.
- [x] Router-to-Reporting Actor projection is covered end to end.
- [x] Router archive key and payload are deterministic.
- [x] Authenticated Runtime-to-Room Actor delivery and durable dedupe are
  covered in workerd.
- [x] Generated Wrangler service, Durable Object, R2, and secret requirements
  contain no secret values.
- [x] Full repository tests, build, security check, audit, and diff check pass.

## Deliberate limits

- This phase compiles deployment artifacts; it does not claim that a production
  deployment has occurred.
- Cross-worker service names currently assume request-response and realtime
  releases use the same Lacify project ID.
- Archive delivery stores one immutable object per explicitly archived event.
  Batching or lifecycle policy optimization requires separate evidence.
- Scale and free-tier claims remain gated by staged load and billing evidence.
