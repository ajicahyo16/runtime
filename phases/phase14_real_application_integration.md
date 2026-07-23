# Phase 14: Real Application Integration

## Status

**Complete — all five milestones passed, including authenticated remote Development diagnostics.**

## Objective

Turn a reviewed Lacify data project into a safe dependency of a real application backend.

The integration loop is:

```text
validated Lacify project
  → generated typed client
    → generated trusted-server adapter
      → secret-free integration manifest
        → backend-owned environment variables
          → local and remote readiness diagnostics
```

Browser code must never receive the runtime credential. Diagnostic output must never return credential values or business rows.

## Milestone 1 — Trusted backend integration contract

- [x] Add `lacify integrate`.
- [x] Generate the deterministic typed client.
- [x] Generate a framework-neutral server adapter.
- [x] Generate `.lacify/integration.json`.
- [x] Describe required environment variables without storing their values.
- [x] Include Actor and operation metadata for application wiring.

### Completion evidence

- The manifest binds the project fingerprint, generated paths, required environment names, and declared operation surface.
- `LACIFY_RUNTIME_TOKEN` is marked secret and server-only.
- The adapter accepts an injected environment and `fetch`, making it usable from Node, Workers, and server frameworks.
- HTTPS is required except for localhost development.
- Runtime token shape is checked before any request.

## Milestone 2 — End-to-end readiness doctor

- [x] Add `lacify doctor`.
- [x] Validate project files, operation fixtures, and migration plans.
- [x] Verify generated client, server adapter, and integration manifest freshness.
- [x] Verify a saved review matches the current canonical source.
- [x] Verify local Development matches the project fingerprint.
- [x] Verify the MCP executable.
- [x] Check backend environment configuration without returning values.

### Completion evidence

- Doctor returns structured pass, warning, and fail checks.
- Missing integration, review, or local apply is a blocker.
- Absent optional backend environment values are warnings; partial or malformed configuration is a blocker.
- Reports explicitly declare `secretsReturned: false` and `businessRowsReturned: false`.

## Milestone 3 — Authenticated remote readiness

- [x] Add `lacify doctor --remote`.
- [x] Verify authenticated project visibility.
- [x] Verify a succeeded Development deployment.
- [x] Inspect active Development credential metadata without token values.
- [x] Keep missing application credentials visible as a warning.
- [x] Exclude Staging and Production mutation.

### Completion evidence

- The live `personal-project-vault` project is visible to the authenticated CLI.
- Development deployment `deploy_f0c20ab1707c6008ac_dev` reports succeeded.
- No active Development credential exists after the Phase 11 acceptance token was deliberately revoked.
- The warning gives the next application-onboarding action without creating or exposing a credential automatically.

## Milestone 4 — AI and application handoff

- [x] Add MCP `get_project_readiness`.
- [x] Keep remote checks explicitly opt-in.
- [x] Add a typed backend project-store example.
- [x] Update the personal template agent instructions.
- [x] Document integration, review, apply, and doctor as one workflow.

### Completion evidence

- Lacify MCP exposes 20 bounded tools.
- The example backend imports only the generated server adapter.
- Application code supplies workspace partitions and typed operation inputs.
- No browser bundle, prompt, example, manifest, or diagnostic contains a runtime credential.

## Milestone 5 — Regression, build, and security acceptance

- [x] Test incomplete and complete doctor states.
- [x] Test secret-free manifests and reports.
- [x] Type-check the generated client and server adapter together.
- [x] Run the complete repository suites and production build.
- [x] Run dependency, workspace security, and formatting checks.

### Completion evidence

- Integration-specific CLI, MCP, generation, and readiness tests pass.
- The complete suite passes 93 tests: 35 Control Plane/hosting tests and 58 runtime-spec tests.
- The generated client, server adapter, and example project-store compile together under strict TypeScript.
- The production build passes, `npm audit` reports zero vulnerabilities, the workspace scan passes across 202 text files, and `git diff --check` is clean.
- Real-project local and authenticated remote doctor reports return ready with only intentional credential-configuration warnings.

## Definition of done

Phase 14 is complete when a backend can consume Lacify through a generated, fingerprint-bound adapter; an AI can inspect readiness through MCP; and the developer can diagnose the complete local and remote Development path without exposing secrets or business rows.

## Out of scope

- Creating an application credential without an explicit developer choice.
- Browser-side Lacify runtime access.
- Framework-specific authentication, routing, or deployment.
- Automatic Staging or Production promotion.
- Returning runtime token values from doctor or MCP.
