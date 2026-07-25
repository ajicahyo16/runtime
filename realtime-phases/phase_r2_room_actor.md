# Phase R2: Generic Room Actor Substrate

## Status

**In progress.** The generic runtime and workerd integration tests are implemented. Production deployment and scale claims are explicitly out of scope until later phases provide operational evidence.

## Objective

Provide an application-neutral realtime substrate for authenticated events, presence, acknowledgements, replay, and reconnect without changing Runtime v1 request-response semantics.

## Implemented

- [x] Compile a validated realtime project into deterministic Worker, Durable Object, SQLite schema, and Wrangler artifacts.
- [x] Verify short-lived, room-scoped HMAC tokens and reject query-string credentials.
- [x] Enforce explicit origins and project, environment, Room Actor, room, and capability audience.
- [x] Upgrade authenticated connections to one hibernating `RoomActor` Durable Object substrate.
- [x] Persist ordered events and client cursors in Durable Object SQLite.
- [x] Acknowledge and deduplicate client event IDs.
- [x] Resume and replay ordered history with bounded batches.
- [x] Broadcast ephemeral presence without persisting presence payloads.
- [x] Enforce frame, connection, queue, replay, and retention bounds.
- [x] Use one persistent event insert on the hot path; keep active cursors in hibernation-safe WebSocket attachments.
- [x] Checkpoint client cursors on disconnect instead of writing a cursor for every event.
- [x] Use WebSocket auto-response for the canonical ping frame so idle health traffic does not wake the actor.
- [x] Require a bounded per-room UTC daily persistent-event budget and fail closed when it is exhausted.
- [x] Return room budget usage and reset metadata in the connection hello frame.
- [x] Exercise the generated artifact in workerd through Miniflare integration tests.

## Remaining acceptance evidence

- [x] Demonstrate hibernation wake-up and replay across Durable Object eviction/restart.
- [ ] Exercise slow-consumer disconnect behavior under controlled load.
- [x] Pass the repository's full test, build, security, and diff gates.

## Scope boundary

R2 does not define timeline feeds, anonymous identities, moderation, product UI, or application-specific chat schemas. Deployment automation, load testing, and production operations remain later-phase work.

The room budget reserves account-level headroom but cannot guarantee that the Cloudflare account remains below its aggregate quota: multiple projects and rooms share the same provider allowance. Account-wide observation and admission control belong to the operations phase.
