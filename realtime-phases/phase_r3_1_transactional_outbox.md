# Phase R3.1: Transactional Outbox

## Status

**Complete.** Transaction, delivery, restart, poison-event, approval, and full repository gates pass. Sink deployment wiring remains environment configuration, not business runtime semantics.

## Objective

Publish committed Runtime v1 command results to realtime, reporting, or archive sinks without making external delivery part of the business transaction.

## Authoring contract

```yaml
emits:
  - event: OrderPlaced
    target: realtime
    durability: segmented
    fields:
      - id
      - total
      - status
```

Only explicitly selected result fields enter the outbox payload.

## Implemented

- [x] Validate bounded command-only `emits` declarations.
- [x] Bind event fields to declared operation result fields.
- [x] Insert runtime-owned outbox rows atomically with business SQL and idempotency receipts.
- [x] Keep existing operations unchanged when `emits` is absent.
- [x] Dispatch at most 16 ready events per batch through an event sink binding.
- [x] Treat a sink conflict as idempotent delivery success.
- [x] Retry with bounded exponential backoff.
- [x] Dead-letter poison events after eight attempts.
- [x] Require exact approval to replay one dead-letter event.
- [x] Reschedule pending delivery through Durable Object alarms.
- [x] Restore pending scheduling after Durable Object restart.
- [x] Expose counts and oldest pending time without payloads in deep health.

- [x] Pass full test, build, security, and diff gates.

## Safety boundary

The sink receives only the versioned event envelope and fields explicitly selected by the operation contract. Delivery failure never rolls back an already committed business command. Realtime and reporting consumers must remain idempotent by `eventId`.
