# Phase R3.5 — Local Capacity and Cost Evidence

## Status

**Complete.**

## Goal

Provide a repeatable, zero-cloud-mutation capacity harness before spending
provider quota or making production scale claims.

## Harness

`npm run realtime:capacity` compiles the canonical realtime fixture and runs it
inside isolated Miniflare instances. Default scenarios cover 30, 100, and 300
users distributed at 10 users per room.

Each user cycle exercises:

- authenticated WebSocket connection;
- hibernation auto-response ping;
- immediate SQLite-backed event and durable acknowledgement;
- segmented R2 event and durable acknowledgement;
- ephemeral presence;
- 10% disconnect and authenticated reconnect;
- post-reconnect immediate event with contiguous client sequence.

The report includes accepted connections, errors, p50/p95 latency, R2 object
count, estimated SQLite writes, and dated free-tier assumptions. It explicitly
marks provider duration and account-wide quota as unmeasured.

## Acceptance thresholds

- Every expected connection is accepted.
- No operation or frame timeout occurs.
- Connection and reconnect p95 are at most 2 seconds locally.
- Immediate durable acknowledgement p95 is at most 2 seconds locally.
- Segmented durable acknowledgement p95 is at most 3 seconds locally.
- Exactly one committed R2 segment exists per test room.
- Every free-tier projection remains below its dated assumption.

## Recorded run

The 2026-07-25 local run passed:

| Users | Rooms | Errors | Connection p95 | Immediate p95 | Segmented p95 | Reconnect p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 3 | 0 | 259.55 ms | 10.77 ms | 35.24 ms | 3.16 ms |
| 100 | 10 | 0 | 75.83 ms | 16.58 ms | 24.31 ms | 6.43 ms |
| 300 | 30 | 0 | 31.21 ms | 15.21 ms | 21.37 ms | 33.71 ms |

For the declared 300-user workload at 60 cycles per day, the behavioral model
estimated 2.1% Worker requests, 5.79% Durable Object requests, 43.5% SQLite row
writes, and 5.4% monthly R2 Class A operations against assumptions checked on
2026-07-25. These are not provider telemetry or a billing guarantee.

Evidence: [`../realtime-evidence/local-capacity-2026-07-25.json`](../realtime-evidence/local-capacity-2026-07-25.json)

## Acceptance

- [x] Add deterministic percentile and budget calculations.
- [x] Exercise 30, 100, and 300 local users.
- [x] Exercise immediate, segmented, ephemeral, and reconnect paths.
- [x] Record failure-recovery coverage from automated fault tests.
- [x] Store a payload-free evidence summary.
- [x] Pass full repository tests, build, security check, audit, and diff check.

## Remaining production gates

- Controlled slow-consumer behavior over a real network.
- Cloudflare staging edge latency and Durable Object duration.
- Account-wide quota observation.
- Reviewed staging deployment and smoke/recovery drill.

Passing this phase does not claim that Cloudflare production can reproduce local
latency or cost.
