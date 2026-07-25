# Lacify Realtime Runtime v1

## Document role

Canonical product vision for Lacify Realtime Runtime v1. Implementation and acceptance records live in [`realtime-phases/`](./realtime-phases/README.md).

## Product status

- Phase R1 is complete.
- Phase R3.3 Event Router and deployment wiring is complete.
- Phase R3.4 production safety and operations is complete.
- Phase R3.5 local 30/100/300-user capacity evidence is complete.
- Realtime Runtime is separate from request-response Lacify Runtime v1.
- No production scale claim exists before staged load evidence passes.

## Product definition

Lacify Realtime Runtime is a Cloudflare-native runtime for long-lived, stateful collaboration:

- Chat
- Presence
- Multiplayer
- Collaborative editors
- Massive live dashboards
- Large-scale WebSocket infrastructure
- Realtime shared documents

One Room Actor substrate serves these profiles. It is not seven independent runtimes.

## Runtime architecture

```text
Client
  → stateless Worker authentication and routing
    → Room Durable Object selected by tenant, environment, room class, and room ID
      → WebSocket Hibernation API
      → private SQLite event history and snapshots
```

## Invariants

- Request-response Runtime v1 contracts remain unchanged.
- Stateless Workers do not own room state.
- One Room Durable Object is an ordering and consistency boundary.
- Presence is ephemeral; restart must reconcile it rather than restore stale state.
- Durable events receive a server-assigned monotonic room sequence.
- Reconnect uses acknowledged sequence replay or snapshot resynchronization.
- Every queue, frame, replay, history, and retention policy is bounded.
- Control Plane stores operational metadata, not chat or document payloads.
- Browser room access requires short-lived, audience-bound authorization.
- Telemetry failure never interrupts accepted room mutations.
- Collaborative documents use a Yjs-compatible protocol; Lacify does not create a CRDT.

## Authoring model

```text
lacify.realtime.yaml
rooms/
  collaboration.room.yaml
.lacify/
  lock.json
```

`lacify.realtime.yaml` identifies project and Room Actor definitions. Room files declare partition strategy, capabilities, durability, retention, limits, and access policy. Deterministic validation and planning happen before approved Development mutation.

## Core capabilities

- `events`: ordered realtime events for chat, multiplayer, and dashboards.
- `presence`: ephemeral member state with TTL.
- `history`: bounded durable replay.
- `document`: opaque Yjs updates and snapshots.

## Delivery order

1. R1 — Contract and deterministic authoring.
2. R2 — Hibernating Room Actor, Chat, and Presence.
3. R3 — Reliability, backpressure, retention, and deployment.
4. R4 — Yjs-compatible documents and editors.
5. R5 — Dashboard streams and multiplayer state.
6. R6 — Operations, recovery, and production readiness.
7. R7 — Staged scale validation and rollout.

## Definition of success

A developer or AI agent can author reviewable realtime room contracts, validate and plan an immutable release, deploy an authenticated hibernating Room Actor, and verify ordering, reconnect, bounded resource use, tenant isolation, and operational evidence without weakening Runtime v1.
