# Lacify personal workspace

This is the Phase 19–21 acceptance workspace for a personal platform made from six independent Lacify projects:

| Project | Actor | Object set |
| --- | --- | --- |
| `crm-personal` | `Workspace` | notes + `workspace-projects@1.0.0` |
| `crm-operations` | `Workspace` | data-free structure generated from `crm-starter@1.0.0` |
| `project-manager` | `Workspace` | notes + `workspace-tasks@1.1.0` |
| `knowledge-base` | `Workspace` | notes |
| `delivery-workspace` | `DeliveryWorkspace` | notes + selected `workspace-tasks@1.1.0` |
| `notes-workspace` | `NotesWorkspace` | notes; all optional modules removed |

The repeated Actor name does not share storage. Each project has its own canonical files, fingerprint, local SQLite database, review receipt, release path, credentials, and MCP mutation context.

Run workspace discovery from this directory:

```bash
lacify workspace-list
lacify workspace-status
lacify workspace-module-matrix
lacify workspace-mcp-config --project project-manager
```

The first three commands are local and metadata-only. The MCP configuration selects exactly one project; use a separate generated configuration when switching projects.

There is intentionally no workspace-wide apply, deployment, restore, or upgrade command.

Phase 20 additionally exports the immutable `crm-starter@1.0.0` blueprint from `crm-personal`. It creates `crm-operations` with a new identity and no copied runtime data:

```bash
lacify blueprints
lacify blueprint-info crm-starter --version 1.0.0
```

See [`BLUEPRINT_ACCEPTANCE.md`](./BLUEPRINT_ACCEPTANCE.md) for exact fingerprints and isolation evidence.

Phase 21 uses the same `workspace-composable@1.0.0` blueprint to produce two different Actor identities and object sets. See [`COMPOSITION_ACCEPTANCE.md`](./COMPOSITION_ACCEPTANCE.md).
