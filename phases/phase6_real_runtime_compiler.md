# Phase 6: Deterministic Runtime Compiler

## Status

**Complete.** The production Control Plane compiles revisioned project contracts into immutable Cloudflare runtime releases.

## Objective

Replace the visual-only prototype with a deterministic compiler whose inputs, generated artifacts, checksum, and deployment identity can be verified and audited.

## Delivered

- [x] Revisioned project and aggregate contract storage in the Control Plane.
- [x] Deterministic compiler for Worker, Durable Object, SQLite, manifest, and web application artifacts.
- [x] Content-derived release checksum and immutable release ID.
- [x] Generated Worker module with stateless routing.
- [x] Generated Durable Object classes and SQLite initialization.
- [x] Generated `schema.sql` and Wrangler metadata.
- [x] Generated command routes and client application metadata.
- [x] Release validation and artifact inspection.
- [x] Local compiler entry point for development and automated tests.

## Canonical production model

The production source of truth is the revisioned Control Plane contract and release artifact stored in D1. The early `/contracts/*.yaml` and Vite middleware approach remains useful as historical prototype context, but is not the production persistence boundary.

Phase 10 will introduce a new, deliberate file-first contract:

```text
lacify.runtime.yaml
actors/<actor>/migrations/*.sql
```

Those files will be synchronized through a CLI and MCP rather than writing directly through Vite middleware.

## Compiler guarantees

- Equivalent normalized inputs produce the same checksum.
- A release is never rebuilt while moving between environments.
- Generated code has bounded routes, commands, payloads, and telemetry.
- Business state belongs to Durable Object SQLite.
- Provider credentials and Control Plane secrets never enter release artifacts.

## Acceptance evidence

- [x] The `lacify-pos` project has multiple verified immutable releases.
- [x] Generated releases deploy successfully to real Workers.
- [x] Worker, Durable Object, and SQLite deep health passes in Production.
- [x] Compiler and telemetry behavior is covered by automated tests.

## Next dependency

Phase 7 deploys compiled releases through the production Control Plane.
