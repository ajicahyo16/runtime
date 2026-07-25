# Phase R1: Realtime Contract

## Status

**Complete.** No production capability or scale claim yet.

## Objective

Establish a separate, deterministic authoring contract for Room Actors without changing request-response Runtime v1.

## Work

- [x] Add canonical Realtime Runtime vision and roadmap.
- [x] Define versioned project and Room Actor manifests.
- [x] Validate capabilities, retention, resource limits, and origin policy.
- [x] Load room files with path containment and deterministic fingerprinting.
- [x] Add contract tests.
- [x] Add CLI validate and plan commands.
- [x] Add metadata-only MCP inspection and planning.
- [x] Pass full quality gates.

## Definition of done

R1 is complete when repository files produce deterministic validation and planning through CLI and MCP, invalid or unsafe bounds fail closed, existing Runtime v1 tests remain green, and no command mutates remote state without explicit approval.
