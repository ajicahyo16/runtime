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

For development inside this repository, create a local `lacify` command:

```bash
npm link
lacify --help
```

You can also replace every `lacify` example below with
`node /absolute/path/to/new-runtime/bin/lacify.mjs`.

## Quick start

Log in, initialize a repository-managed project, and enter its directory:

```bash
lacify login
lacify init --project my-project --template personal
cd my-project
```

Run the local feedback loop while editing Actor contracts:

```bash
lacify validate
lacify test
lacify dev
```

When the change is ready, generate and inspect its review receipt:

```bash
lacify integrate
lacify plan
lacify review
git diff
```

The last command prints a `review_...` ID. Ship the exact reviewed state to
Development only after inspecting the diff:

```bash
lacify ship development \
  --review review_REPLACE_WITH_THE_PRINTED_ID \
  --approve
```

Confirm that repository source, deployment, credentials, and runtime access
agree:

```bash
lacify status --remote
lacify doctor --remote
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

The workflow is resumable and writes a secret-free checkpoint to
`.lacify/ship-state.json`. Release compilation, verification, and deployment
retry only transient failures (for example Cloudflare `429`, `5xx`, network
resets, and bounded D1 CPU resets) with bounded exponential backoff. Validation,
authorization, and contract failures fail immediately.

If a transient failure interrupts `ship`, rerun the same command with the same
review ID. Lacify resumes verified work from the checkpoint instead of creating
unnecessary releases. Do not manually edit the checkpoint.

Before compiling a release, `ship` compares active Development credential
capabilities with the repository operation surface. If credentials already
exist but omit a newly declared operation, deployment stops with the exact
`Actor.Operation` diff instead of allowing the application to discover it as a
runtime `403`.

## Runtime credential rotation

Create a least-surprise replacement credential for the complete current
operation surface:

```bash
lacify credential-rotate development \
  --name my-backend-v2 \
  --token-file /protected/outside/repository/runtime-token \
  --approve
```

The token is written once with mode `0600`; it is never printed or placed in
the repository. Update the trusted backend secret from that file, rerun
`lacify ship development`, perform the application smoke test, and only then
revoke the old credential in Runtime Access. This two-phase sequence prevents
an eager revoke from taking a healthy backend offline.

For an application or backend runtime check, expose the replacement credential
only through server-side environment variables:

```bash
export LACIFY_RUNTIME_URL="https://your-runtime.example"
export LACIFY_RUNTIME_TOKEN="replace-with-the-protected-token"
lacify doctor --remote
```

Do not prefix the variables with `VITE_`, `NEXT_PUBLIC_`, or another
browser-visible convention.

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

When `LACIFY_RUNTIME_URL` and `LACIFY_RUNTIME_TOKEN` are present,
`doctor --remote` also calls the metadata-only `GET /__lacify/access` probe.
The probe authenticates the exact configured credential and compares its
capabilities with every declared operation without routing to a Durable Object
or reading business rows.

Generated clients throw `LacifyRuntimeError` with stable `status`, `code`,
`message`, and `retryable` fields. Backends can preserve errors such as
`operation_forbidden` instead of collapsing them into an opaque `502`.

## Recovery guide

- `review mismatch`: rerun `validate`, `test`, `integrate`, `plan`, and
  `review`; never approve an old receipt for changed source.
- `credential capability gap`: create a replacement with
  `credential-rotate`, update the backend secret, ship again, smoke-test, then
  revoke the old credential.
- `runtime_unauthorized`: verify the server-side runtime URL/token and run
  `doctor --remote`; do not keep retrying a rejected credential.
- `429`, `5xx`, network reset, or bounded D1 CPU reset: rerun the same `ship`
  command. The resumable checkpoint and bounded retry protect completed work.
- stale remote status: run `lacify status --remote`; compile and ship the
  currently reviewed repository fingerprint instead of trusting an older
  healthy deployment.

For machine-readable output in automation, add `--json` to commands that
support it. Never parse human-readable error sentences when a structured
`code` is available.

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
