# Realtime Evidence

This directory contains bounded, reviewable evidence summaries. It never stores
credentials, room payloads, user messages, or provider billing exports.

Local capacity evidence is produced with:

```sh
npm run realtime:capacity
```

The harness runs only through local Miniflare. It creates isolated temporary
Workers, Durable Objects, SQLite databases, R2 buckets, and WebSockets. It does
not deploy or consume Cloudflare quota.

Budget projections use dated assumptions so they cannot be confused with
provider telemetry. Before a production decision, recheck the official
[Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
then run the separately approved staging gate.
