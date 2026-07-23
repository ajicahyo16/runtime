# Phase 19: Multi-Project Workspace and AI Discovery

## Status

**Complete — all five milestones passed with a three-project personal workspace.**

## Objective

Let one developer organize multiple independent Lacify projects as a personal platform while keeping every Actor, database, release, credential, and mutation scoped to exactly one project.

The workspace is a discovery and coordination boundary:

```text
lacify.workspace.yaml
  → contained project catalogs
    → metadata-only status and module comparison
      → explicit project selection
        → one project-bound MCP process
```

It is not a shared database and it does not turn similarly named Actors into one Actor.

## Milestone 1 — Explicit workspace manifest

- [x] Add the `lacify.dev/workspace/v1` manifest.
- [x] Add `lacify workspace-init`.
- [x] Validate bounded workspace names and relative project paths.
- [x] Limit a workspace to 128 project entries.
- [x] Refuse invalid YAML, unknown manifest shapes, duplicate paths, and overwrite of an existing manifest.

### Completion evidence

- `lacify.workspace.yaml` contains only workspace identity and project paths.
- Runtime credentials, environment values, business rows, and deployment state are not stored in the manifest.

## Milestone 2 — Contained and unique projects

- [x] Add `lacify workspace-add <relative-path>`.
- [x] Resolve real filesystem paths before accepting a project.
- [x] Reject absolute escapes, traversal, symlink escapes, and the workspace root itself.
- [x] Require a valid `lacify.runtime.yaml`.
- [x] Reject duplicate canonical paths and duplicate runtime project IDs.

### Completion evidence

- Every registered project is physically contained inside the workspace root.
- Two projects may both define an Actor named `Workspace`; their files, SQLite databases, fingerprints, and lifecycle remain independent.

## Milestone 3 — Metadata-only workspace operations

- [x] Add `lacify workspace-list`.
- [x] Add `lacify workspace-status`.
- [x] Add `lacify workspace-module-matrix`.
- [x] Report project fingerprints, Actor names, partition keys, operation counts, readiness, and module version state.
- [x] Return no business rows and perform no remote mutation.

### Completion evidence

- Workspace status runs each project's bounded local doctor independently.
- Module comparison reports `current`, `update-available`, customized states, or `none` without installing or upgrading anything.
- There is deliberately no bulk apply, deploy, restore, or module-upgrade command.

## Milestone 4 — Explicit AI project context

- [x] Add `lacify workspace-mcp-config --project <project-id>`.
- [x] Bind the generated MCP process to an exact project root and project ID.
- [x] Reject MCP startup/use when the selected project ID does not match the repository.
- [x] Add workspace catalog, project lookup, and module-matrix MCP tools.
- [x] Add a metadata-only workspace MCP resource.

### Completion evidence

- MCP exposes 37 bounded tools.
- Peer projects can be discovered, but `selectedForMutation` is true for only the process-bound project.
- Selecting another project requires starting its explicit MCP configuration; discovery never changes mutation context.
- Runtime tokens remain environment placeholders and are never printed.

## Milestone 5 — Three-project personal-platform acceptance

- [x] Create `examples/personal-workspace`.
- [x] Register `crm-personal`, `project-manager`, and `knowledge-base`.
- [x] Keep the same `Workspace` Actor name isolated in all three projects.
- [x] Compose `workspace-projects@1.0.0` only into CRM.
- [x] Compose `workspace-tasks@1.1.0` only into project management.
- [x] Keep the knowledge base on the base notes object set.
- [x] Integrate, review, locally apply, and diagnose each project independently.
- [x] Run complete quality gates.

### Completion evidence

- All three example projects report ready with no blockers.
- Their Actor operation counts are 5, 6, and 2 respectively.
- Their fingerprints are distinct even though the Actor name and partition key are shared.
- Automated tests cover containment, duplicate IDs/paths, module isolation, metadata-only discovery, explicit MCP selection, and mismatched-context rejection.
- The complete suite passes 101 tests: 35 Control Plane/hosting tests and 66 runtime-spec tests.
- The production build passes, `npm audit` reports zero vulnerabilities, the workspace security scan passes, and `git diff --check` is clean.

## Definition of done

Phase 19 is complete when an AI coding agent can discover the projects in one personal workspace, inspect their safe structure and module state, then work through a separately selected project-bound MCP process without crossing project data or mutation boundaries.

## Out of scope

- Cross-project SQL joins or shared Actor databases.
- Automatic reuse of one project's runtime data in another project.
- Bulk apply, deployment, rollback, restore, or module upgrades.
- Implicit project switching inside one MCP process.
- Returning business rows, secrets, or plaintext credentials through workspace discovery.
