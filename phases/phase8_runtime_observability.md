# Phase 8: Runtime Observability and Aggregate Operations

## Status

**Complete.** Runtime telemetry, deep health, aggregate operations, incidents, retention, export, and cost estimates are deployed.

## Objective

Make every deployed Lacify runtime observable from the Control Console without showing synthetic data. A workspace member must be able to answer:

1. Is each environment healthy?
2. Which release is currently running?
3. Which Business Aggregate or command is failing?
4. How much traffic, latency, storage, and estimated cost is the runtime producing?
5. What changed immediately before a regression?

This phase builds on the immutable releases and `deployment_jobs` workflow from Phase 7. It does not replace Cloudflare Analytics; it provides a Lacify-specific operational view organized around Business Aggregates.

## Current baseline

- [x] The Control API exposes `GET /api/monitor-overview?project=<project-id>`.
- [x] The Monitor UI loads real deployment jobs and stored runtime events.
- [x] Browser-local projects remain usable without presenting fake telemetry.
- [x] Deployment jobs retain state, runtime URL, smoke-check result, and deployment logs.
- [x] Deployed Workers can securely submit runtime events to the Control API.
- [x] Runtime health, metrics, storage, alerts, and cost data are persisted.

## Product and security rules

- Never display generated/demo metrics as real runtime data.
- Monitoring data is scoped by workspace, project, release, deployment, and environment.
- A runtime may write telemetry only for its own deployment identity.
- Telemetry credentials are generated per deployment, stored as secrets, revocable, and never returned by read APIs.
- Request bodies, authorization headers, cookies, command payloads, and business records must not be logged by default.
- Errors may contain command names, aggregate types, partition-key hashes, status codes, durations, and safe diagnostic messages.
- Raw partition keys require an explicit opt-in policy; the default is a one-way hash.
- Telemetry ingestion must never block or fail a business command.
- Retention, sampling, and aggregation limits must prevent unbounded database growth.

## Target data flow

```text
Generated Runtime Worker
  |-- command timing and outcome
  |-- Durable Object / SQLite health
  |-- aggregate-safe diagnostic event
  v
Telemetry ingestion endpoint
  |-- authenticates deployment identity
  |-- redacts and validates payload
  |-- stores bounded raw events
  `-- updates time-bucket aggregates
  v
Lacify Control API
  |-- health summary
  |-- metrics series
  |-- aggregate explorer
  |-- deployment correlation
  `-- alerts and cost estimates
  v
Observability UI
```

## Milestone 1 — Telemetry identity and ingestion

### Work

- [x] Add a migration for deployment telemetry credentials and revocation metadata.
- [x] Generate a scoped telemetry credential during deployment and install it as a Worker secret.
- [x] Add `POST /api/runtime-telemetry/events` for batched runtime events.
- [x] Authenticate by deployment ID and credential hash, not by the user's Uplink session.
- [x] Define a versioned event envelope containing:
  - schema version;
  - deployment and release IDs;
  - environment;
  - event ID and timestamp;
  - aggregate type and hashed partition key;
  - command/action name;
  - outcome, duration, and safe error metadata.
- [x] Reject oversized, expired, malformed, cross-project, or replayed batches.
- [x] Add server-side redaction and payload-size limits.
- [x] Buffer telemetry in the generated runtime and submit it asynchronously with a short timeout.
- [x] Record dropped-event counts locally so telemetry failures remain visible without breaking commands.

### Acceptance criteria

- [x] A deployed runtime can submit an authenticated event batch.
- [x] A credential for one deployment cannot write data for another deployment.
- [x] Replayed event IDs do not create duplicate records.
- [x] Business payload fields and plaintext credentials never appear in stored telemetry or logs.
- [x] The runtime command response succeeds even when telemetry ingestion is unavailable.

## Milestone 2 — Health and deployment correlation

### Work

- [x] Add periodic health samples for the Worker, Durable Object, and SQLite layers.
- [x] Store last success, last failure, latency, checked endpoint, release ID, and deployment ID.
- [x] Distinguish `healthy`, `degraded`, `unhealthy`, `deploying`, and `unknown` states.
- [x] Mark data stale when no sample arrives inside the configured interval.
- [x] Extend the Monitor UI with environment cards for Development, Staging, and Production.
- [x] Link health failures to the deployment log and immutable release checksum.
- [x] Show the last successful deployment and the last operational error without exposing secrets.

### Acceptance criteria

- [x] The console shows the current health and release for every deployed environment.
- [x] Stale telemetry is labelled `unknown`; it is never shown as healthy.
- [x] A failed health check identifies the affected layer and Business Aggregate when known.
- [x] Operators can navigate from a health regression to its deployment and release.

## Milestone 3 — Worker and command metrics

### Work

- [x] Aggregate events into fixed time buckets for request count, success count, error count, and latency.
- [x] Calculate average, P50, P95, and P99 latency from bounded distributions.
- [x] Track CPU time and wall time when the runtime/provider exposes them reliably.
- [x] Add filters for time range, environment, release, aggregate type, and command.
- [x] Add summary cards for requests, error rate, average latency, and P95 latency.
- [x] Add a command table ranked by traffic, latency, and failures.
- [x] Label unavailable provider metrics as unavailable instead of estimating them.

### Acceptance criteria

- [x] Metrics can be filtered without mixing environments or releases.
- [x] Dashboard totals match the stored time buckets for the selected range.
- [x] A user can identify the slowest and most error-prone command.
- [x] Empty ranges show an explicit no-data state.

## Milestone 4 — Business Aggregate and SQLite explorer

### Work

- [x] Track request count, errors, duration, SQLite reads/writes, and storage size per Business Aggregate.
- [x] Add a privacy-safe partition explorer based on hashed partition keys.
- [x] Record table row estimates, database size, daily growth, and top tables when available.
- [x] Add storage thresholds and growth warnings before platform limits are reached.
- [x] Display the aggregate boundary explicitly as `Business Aggregate -> Durable Object -> SQLite`.
- [x] Add drill-down from an aggregate to commands, lifecycle failures, deployment, and release.

### Acceptance criteria

- [x] Operators can identify an aggregate with abnormal latency, failures, or storage growth.
- [x] Partition identifiers are not reversible from the default UI or API responses.
- [x] Storage warnings include the current size, recent growth rate, and threshold.
- [x] The explorer never implies that one business record equals one Durable Object.

## Milestone 5 — Alerts and incident workflow

### Work

- [x] Add alert rules for health failure, error-rate increase, latency threshold, missing telemetry, and storage growth.
- [x] Support warning and critical severities with a configurable evaluation window.
- [x] Persist alert state transitions: `open`, `acknowledged`, `resolved`.
- [x] Deduplicate repeated occurrences into one incident.
- [x] Correlate incidents with releases and deployment timestamps.
- [x] Add an incident timeline with safe diagnostic events and operator notes.
- [x] Keep outbound notification providers optional; begin with in-console alerts.

### Acceptance criteria

- [x] Repeated identical failures do not create an alert storm.
- [x] An alert records when it opened, who acknowledged it, and when it resolved.
- [x] A deployment-related regression links to the suspected release without claiming causation as fact.
- [x] Alert evaluation continues independently of an open browser session.

## Milestone 6 — Cost visibility

### Work

- [x] Store versioned Cloudflare pricing inputs with effective dates and source metadata.
- [x] Calculate Worker requests, Durable Object duration, SQLite reads/writes, storage, R2, and Queue estimates only from available usage data.
- [x] Separate observed usage from estimated cost in the data model and UI.
- [x] Show daily cost, month-to-date estimate, projected monthly cost, and change versus the previous period.
- [x] Add cost breakdowns by environment and Business Aggregate where attribution is reliable.
- [x] Warn when a metric cannot be attributed precisely.

### Acceptance criteria

- [x] Every estimate identifies its pricing version, time range, and included usage categories.
- [x] Missing usage never becomes a zero-cost claim.
- [x] Users can distinguish provider-billed values from Lacify estimates.
- [x] A large cost change can be traced to a usage category and environment.

## Milestone 7 — Retention, export, and operational hardening

### Work

- [x] Define raw-event, metric-bucket, health-sample, and incident retention policies.
- [x] Add scheduled compaction and deletion jobs.
- [x] Add ingestion rate limits, sampling controls, backpressure, and per-workspace quotas.
- [x] Export filtered events and metrics as JSON or CSV with workspace authorization checks.
- [x] Add audit events for telemetry credential creation, rotation, revocation, exports, and alert actions.
- [x] Add load tests for ingestion and query endpoints.
- [x] Add failure tests for duplicate batches, delayed events, clock skew, malformed data, and unavailable storage.
- [x] Document telemetry credential rotation and incident-response procedures.

### Acceptance criteria

- [x] Retention jobs cannot delete another workspace's data.
- [x] Ingestion remains bounded during a traffic spike.
- [x] Exported data matches the active filters and contains no secrets or command payloads.
- [x] Credential rotation can occur without redeploying an unrelated environment.

## Suggested schema additions

- `telemetry_credentials`
- `runtime_event_batches`
- `runtime_events` additions for deployment/release/environment identity
- `runtime_metric_buckets`
- `runtime_health_samples`
- `aggregate_storage_samples`
- `alert_rules`
- `incidents`
- `incident_events`
- `pricing_versions`
- `usage_cost_estimates`

Exact migrations should be introduced milestone by milestone rather than as one large migration.

## Delivery order

1. Telemetry identity and ingestion.
2. Health and deployment correlation.
3. Worker and command metrics.
4. Business Aggregate and SQLite explorer.
5. Alerts and incident workflow.
6. Cost visibility.
7. Retention, export, and operational hardening.

Do not begin cost attribution or alerting from placeholder values. Milestones 5 and 6 depend on trustworthy ingestion, environment scoping, and time-bucket aggregation.

## Definition of done

Phase 8 is complete when a production deployment can securely emit operational telemetry, the Lacify console can display real health and aggregate-level metrics, incidents can be detected and audited, cost estimates clearly disclose their basis, and telemetry failures never interrupt the user's business runtime.

## Out of scope

- Capturing full command payloads or business records.
- Replacing Cloudflare's complete account-level analytics platform.
- Claiming exact billing when provider billing data is unavailable.
- Automatically rolling back Production solely from a client-side dashboard condition.
- Cross-workspace aggregate comparisons or shared telemetry credentials.

## Next dependency

Phase 9 adds application access, production governance, recovery, and service readiness.
