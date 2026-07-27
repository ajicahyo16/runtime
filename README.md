# Lacify Runtime

Lacify is a database-as-code runtime for transactional, partitioned business
aggregates on Cloudflare Workers, Durable Objects, and SQLite.

The repository is the source of truth. Actor contracts, forward-only
migrations, typed operations, and deterministic tests are reviewed locally
before an immutable release reaches Development.

## Requirements

- Node.js
- npm
- A Cloudflare account for remote deployments

Install dependencies:

```bash
npm install
```

Run all tests:

```bash
npm test
```

## CLI

Use the repository CLI directly:

```bash
node bin/lacify.mjs --help
```

When the package is linked or installed, use `lacify` instead.

Initialize a project:

```bash
lacify init --project my-project --template personal
```

## Effortless Development workflow

Author and verify everything locally:

```bash
lacify validate
lacify test
lacify integrate
lacify plan
lacify review
```

The review command returns an immutable `review_...` receipt. Inspect that
receipt and the source diff before approving a mutation.

Publish reviewed source without creating a release:

```bash
lacify sync --review <review-id> --approve
```

Run the complete Development golden path:

```bash
lacify ship development --review <review-id> --approve
```

`ship development` performs the existing guarded workflow:

1. Revalidates the review receipt against the current source and tests.
2. Applies pending migrations to local Development.
3. Synchronizes canonical contracts and the source fingerprint.
4. Compiles and verifies an immutable release.
5. Deploys the release to remote Development.
6. Runs the runtime health check.

It does not promote to Staging or Production.

## Honest status checks

Local status:

```bash
lacify status
```

Compare repository source, the Control Plane, and Development:

```bash
lacify status --remote
lacify doctor --remote
```

Remote readiness requires all of the following:

- the project is visible to the authenticated CLI;
- the Control Plane source fingerprint matches the repository;
- an immutable release exists for that fingerprint;
- the matching release is successfully deployed to Development.

Therefore, an old healthy deployment is reported as stale rather than ready.

## Authentication

Authenticate the CLI using device login:

```bash
lacify login
```

Credentials are stored in the protected operating-system credential store.
Runtime application tokens remain server-side secrets and must never be
committed to Actor files, generated browser bundles, or documentation.

## Durable Object cost guard

Use local SQLite and local runtime tests as the normal development loop:

```bash
lacify test
lacify dev
```

Use remote Development only at a release boundary through
`lacify ship development`. Avoid repeatedly deploying for UI-only changes or
using remote Durable Objects as fixture databases. Dashboard telemetry should
use bounded polling and pause while the page is hidden.

This keeps remote writes and Durable Object requests focused on smoke tests and
real application validation.

## Local Control Plane and dashboard

Create a development-only `.dev.vars` as described in
[`control-plane/LOCAL_DEVELOPMENT.md`](control-plane/LOCAL_DEVELOPMENT.md), then
run:

```bash
npm run control:dev
npm run dev
```

The dashboard uses the same Control API contract as immutable remote releases.

## Repository map

- `runtime-spec/` — schemas, validation, CLI, local runtime, MCP, and generators
- `control-plane/` — authentication, canonical projects, releases, deployment,
  and observability
- `src/` — React dashboard
- `hosting/` — hosted UI worker
- `realtime-phases/` — realtime runtime roadmap and qualification evidence
- `examples/` — example projects and acceptance workflows

## Safety model

- Never edit an applied migration; add the next forward-only migration.
- Never apply without inspecting an exact review receipt.
- Never place credentials or business rows in generated files or review data.
- Development may be shipped from the CLI.
- Staging and Production remain behind Control Plane governance.

See [`runtime-spec/AI_AUTHORING.md`](runtime-spec/AI_AUTHORING.md) for the full
authoring contract.
