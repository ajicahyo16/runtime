# Phase 12: Personal Developer Platform

## Status

**Complete — all five milestones passed, including deployed desktop and mobile Console acceptance.**

## Objective

Turn the completed database-as-code and executable-operation engine into a comfortable daily platform for one developer and their AI coding agent.

The primary loop is:

```text
lacify init --template personal
  → AI connects through Lacify MCP
    → AI proposes reviewable migration and operation files
      → local validation and tests
        → explicit Development apply
          → user creates a scoped runtime credential
            → trusted application backend uses the generated SDK
```

The Console must make the security-sensitive parts understandable without exposing tokens, SQL, prompts, or business rows.

## Milestone 1 — Runtime access Console

- [x] Add a dedicated Runtime access navigation surface.
- [x] Load declared Actor operations and existing credential metadata.
- [x] Create credentials scoped to environment, Actor, and operations.
- [x] Configure bounded request and payload limits.
- [x] Show the plaintext token only in the creation response.
- [x] List active, expired, and revoked credentials without token values.
- [x] Revoke credentials with an explicit warning that redeployment is required.

### Completion evidence

- `RuntimeAccessView` exposes operation-level capability selection and uses the Phase 11 Control Plane credential API.
- The form supports 1–365-day lifetimes, 1–10,000 requests per minute, and 8/32/64 KiB payload presets within server-enforced limits.
- Credential values exist only in transient component state after creation. Reloaded lists contain metadata only.
- The page links directly to Releases for immutable policy activation.

## Milestone 2 — One-command personal project bootstrap

- [x] Add `lacify init --template personal`.
- [x] Include a usable Actor, migration, command, query, and deterministic test.
- [x] Include repository guidance for AI agents.
- [x] Keep the existing minimal `basic` template.

### Completion evidence

- The personal template creates a private `Workspace` Actor with `CreateNote` and `GetNote`.
- A generated project passes `lacify validate`, `lacify test`, and `lacify generate` immediately.
- Initialization refuses to overwrite an existing Lacify project.

## Milestone 3 — MCP and SDK setup

- [x] Add `lacify mcp-config`.
- [x] Generate a bounded MCP server configuration for the current repository.
- [x] Reference the runtime credential by environment-variable placeholder only.
- [x] Show MCP and generated SDK setup guidance in the Console.
- [x] Warn against browser-side or prompt-side token exposure.

### Completion evidence

- MCP configuration includes an absolute executable path, repository working directory, developer role, and `${LACIFY_RUNTIME_APPLICATION_TOKEN}` placeholder.
- Tests prove no `lacify_runtime_*` credential is emitted by the command.
- The Runtime access page shows server-side SDK construction and the MCP launch pattern.

## Milestone 4 — Review-to-deploy handoff

- [x] Keep file authoring in CLI/MCP rather than exposing arbitrary SQL in the Console.
- [x] Require local validation, tests, and deterministic generation.
- [x] Link access-policy changes to the existing immutable Releases workflow.
- [x] Preserve Phase 11 approval, governance, telemetry, and audit boundaries.

### Completion evidence

- Runtime access never accepts SQL or business payloads.
- The Console operation picker is derived from server-validated immutable contracts.
- “Open Releases to redeploy” moves directly to the governed release surface.
- Existing Control Plane roles, CSRF protection, capability checks, and audit events remain authoritative.

## Milestone 5 — Live personal-platform acceptance

- [x] Deploy the updated Control Console.
- [x] Verify Runtime access against the authenticated Control Plane APIs.
- [x] Confirm operation selection and credential metadata contracts.
- [x] Confirm navigation to Releases and responsive layout.
- [x] Run the complete build, regression, and security gates.

### Completion evidence

- Control Console version `645c3c86-8b97-4956-9ec2-a26b45dd1665` is deployed to `https://runtime.getlacify.com`.
- Desktop browser acceptance confirmed the Runtime access navigation, secure empty/error state, bounded form controls, MCP/SDK guidance, credential list, and Releases handoff.
- Mobile acceptance at 390 × 844 confirmed the dedicated View selector and a usable single-column Runtime access layout.
- Authenticated CLI/API acceptance from Phase 11 confirms the live project exposes its operation and credential metadata through the same Control Plane routes consumed by the page.
- The final suite passes 89 tests: 35 Control Plane/hosting tests and 54 runtime-spec tests.
- TypeScript and Vite production builds pass, `npm audit` reports zero vulnerabilities, the workspace security scan passes, and `git diff --check` is clean.

## Definition of done

Phase 12 is complete when a developer can bootstrap an executable personal project, connect an AI through MCP without placing a token in prompts, manage least-privilege runtime credentials in the Console, and hand policy changes into the governed deployment workflow.

## Out of scope

- Browser-side distribution of runtime credentials.
- Arbitrary SQL editors or remote database consoles.
- Automatic Production credential creation.
- Third-party identity providers for customer-facing applications.
- Multi-tenant billing or public marketplace distribution.
