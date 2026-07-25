# Phase R3.6 — Cloudflare Staging Qualification

## Status

**In progress.**

## Goal

Qualify the compiled request-response, router, reporting, and realtime runtime
on isolated Cloudflare staging resources before any production rollout.

## Isolation

- Project ID: `qualification-staging`
- Environment: `staging`
- Every Worker name includes `qualification-staging`.
- The R2 bucket is staging-only.
- `workers.dev` is used; no production route or custom domain is changed.
- Secrets are generated ephemerally and are never written into source,
  artifacts, logs, or evidence.
- Production resources are not referenced.

## Deployment order

1. Realtime Worker, Room Actor, and history bucket.
2. Reporting Worker and Reporting Actor.
3. Event Router and service bindings.
4. Request-response Runtime and router binding.
5. Exact-approval read-only preflight.

The generated qualification manifest lives under the ignored
`.lacify/staging-qualification/` directory and can be reproduced with:

```sh
npm run realtime:staging:prepare
```

## Staged evidence

- [x] Validate local source and generated staging artifact isolation.
- [x] Authenticate Wrangler against the intended Cloudflare account.
- [ ] Push a green source checkpoint.
- [ ] Deploy all isolated staging components.
- [ ] Apply staging secrets without persisting their values.
- [ ] Run exact deployment preflight and component health checks.
- [ ] Run 30, 100, and 300 external WebSocket clients incrementally.
- [ ] Exercise real-network reconnect and slow-consumer behavior.
- [ ] Exercise downstream outage and recovery without source-operation replay.
- [ ] Record Cloudflare latency, Durable Object metrics, storage usage, and
  relevant quota evidence without payloads.
- [ ] Pass final repository quality gates.

## Stop conditions

The qualification stops before the next load stage if error rate is non-zero,
p95 exceeds its declared threshold, preflight is unhealthy, a circuit remains
open, storage evidence is inconsistent, or provider quota headroom is unsafe.
