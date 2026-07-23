# Observability operations

## Data retention and quotas

Workspace defaults are intentionally bounded:

- raw runtime events: 30 days;
- health and storage samples: 30 days;
- five-minute metric buckets: 395 days;
- resolved incidents: 395 days;
- accepted runtime events: 100,000 per workspace per UTC day;
- runtime sampling: 100% by default.

The Control API cron runs every five minutes. It samples health, evaluates alert rules, refreshes cost estimates, and deletes data older than the owning workspace's policy. Every deletion includes `workspace_id` in its predicate.

Update policy through `PUT /api/observability-settings`. A changed sampling rate takes effect on the next deployment of each affected runtime environment.

## Telemetry credential rotation

Use the release deployment endpoint with `redeploy: true` for the exact release and environment. The Control API creates a new random credential, stores only its SHA-256 hash, installs the plaintext value as a Worker secret, and revokes the previous credential. Do not rotate unrelated environments.

After rotation:

1. Confirm the deployment smoke check passes.
2. Execute one safe command against the runtime.
3. Confirm the event appears in `runtime_telemetry_events` and its metric bucket.
4. Confirm the old credential has `revoked_at` set.

## Incident response

1. Open Observability and identify the environment, release, deployment, layer, and aggregate.
2. Acknowledge the incident to establish ownership.
3. Review its timeline and the immutable release checksum; correlation does not prove causation.
4. Check the deep health endpoint and recent command metrics without inspecting command payloads.
5. Roll back through the release workflow when operator judgment requires it; the dashboard never performs an automatic client-side rollback.
6. Add a safe note, resolve the incident, and export filtered JSON/CSV evidence if needed.

Never place cookies, authorization headers, Uplink tokens, telemetry credentials, plaintext partition keys, command payloads, or business records in incident notes or exports.

## Cost interpretation

Cost cards use the pricing version and source URL stored with each estimate. They show observed usage separately from gross list-rate estimates. Account-wide included usage, CPU time, and Durable Object active-duration are not attributed when reliable provider data is unavailable; missing categories are disclosed rather than treated as zero.
