# Phase 21: Parameterized Blueprint Composition

## Status

**Complete — one composable blueprint produced two independently reviewed projects with different Actor identities and object sets.**

## Objective

Turn an immutable blueprint from a whole-project copy of source structure into a safe composition contract:

```text
blueprint v2
  + new project ID
  + Actor rename map
  + partition-key map
  + explicit module selectors
    → schema/operation conflict validation
      → exact file-hash plan
        → approved independent project
```

Blueprint v1 remains readable and creatable with its original project-only parameter.

## Milestone 1 — Backward-compatible composition metadata

- [x] Add `lacify.dev/blueprint/v2`.
- [x] Keep v1 validation and materialization support.
- [x] Record each source Actor file.
- [x] Record current module file ownership and Actor command/operation patches.
- [x] Use canonical `Actor:module` selectors.
- [x] Bind all composition metadata into the immutable blueprint fingerprint.

### Completion evidence

- Export uses only current and uncustomized installed module baselines.
- Module-owned test fixtures remain excluded.
- Module files must have one owner inside the correct Actor directory.
- Module Actor patches cannot overlap.

## Milestone 2 — Typed composition parameters

- [x] Add Actor rename maps.
- [x] Add partition-key maps.
- [x] Add explicit module selection, with `none` for the empty set.
- [x] Keep the existing project-ID and direct-child target parameters.
- [x] Validate source Actor names, target Actor names, partition identifiers, selector existence, selector ambiguity, duplicates, and renamed-Actor uniqueness.

### CLI

```text
lacify blueprint-plan workspace-composable \
  --version 1.0.0 \
  --project delivery-workspace \
  --rename-actor Workspace=DeliveryWorkspace \
  --partition-key Workspace=deliveryWorkspaceId \
  --modules workspace-tasks
```

Use a comma-separated selector list or `--modules none`. When a module name exists on multiple Actors, use the full `Actor:module` selector.

## Milestone 3 — Safe file-level composition

- [x] Remove unselected module migrations and operation files.
- [x] Remove corresponding Actor commands and operation references.
- [x] Rewrite selected Actor names and partition keys.
- [x] Validate the complete canonical project.
- [x] Execute all composed migrations in isolated in-memory SQLite.
- [x] Compile every retained operation SQL statement against the composed schema.
- [x] Bind normalized parameters, projected fingerprint, and every generated file hash into the plan.

### Completion evidence

- A parameter change invalidates plan replay.
- Missing module schema dependencies or broken operation SQL block planning.
- Existing targets are never overwritten.
- Composition performs no remote mutation.

## Milestone 4 — MCP composition

- [x] Extend blueprint inspect with composability and safe selector metadata.
- [x] Extend plan/create tools with `actorRenames`, `partitionKeys`, and `modules`.
- [x] Keep the exact source-project MCP context requirement.
- [x] Keep developer-or-higher authorization and explicit approval.
- [x] Audit a composition fingerprint without SQL or rows.

### Completion evidence

- MCP continues to expose 41 bounded tools.
- Planning returns resulting Actor/module metadata and file hashes without file contents.
- Approved creation must replay the exact blueprint fingerprint, normalized parameters, and plan ID.

## Milestone 5 — Two-composition acceptance

- [x] Export `workspace-composable@1.0.0` from `project-manager`.
- [x] Create `delivery-workspace` with renamed Actor, new partition key, and `workspace-tasks`.
- [x] Create `notes-workspace` with renamed Actor, new partition key, and no modules.
- [x] Add independent behavioral tests to both projects.
- [x] Integrate, review, and locally apply both projects.
- [x] Verify all six workspace projects are ready.
- [x] Run complete quality gates.

### Completion evidence

- Blueprint fingerprint: `2172e7d03ab41c25377c44206626d999bbba7998626f4030737e1b24f49bd1c7`.
- `delivery-workspace` fingerprint: `5ea7fb7dfe92eb8f2d027999ef714fa916714b3fbb351959e9104649ff0bc563`.
- `delivery-workspace` review: `review_28ddf2a570048a5d59ad4abc130e37bd38d9d696`.
- `notes-workspace` fingerprint: `e548d1b7f43ce80e28c5764af16b2542bf9b3c3eb2f83ae69029ad1da0241e98`.
- `notes-workspace` review: `review_0378f69c307446637dc5241654ef9990bcc082c8`.
- The delivery composition has six operations; the notes composition has two.
- The complete suite passes 105 tests: 35 Control Plane/hosting tests and 70 runtime-spec tests.
- The production build passes, `npm audit` reports zero vulnerabilities, the workspace security scan passes, and `git diff --check` is clean.

## Definition of done

Phase 21 is complete when one immutable blueprint can deterministically create separately identified projects with explicitly selected modules, Actor names, and partition keys while validating the resulting SQLite schema and operation contracts before any file creation.

## Out of scope

- Arbitrary text substitution inside SQL.
- Renaming Actor source directories.
- Adding modules that were not part of the source blueprint.
- Copying module installation history into generated projects.
- Copying source tests or runtime data.
- Automatically applying or deploying a generated composition.
