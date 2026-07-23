# Lacify Runtime Roadmap

`LacifyRuntimev1.md` is the canonical product vision. This directory contains implementation phases and acceptance evidence.

| Phase | Title | Status |
| --- | --- | --- |
| [1](./phase1_ui_ux_visuals.md) | Control Console UI/UX Foundation | Complete |
| [2](./phase2_cloudflare_integration.md) | Secure Cloudflare Uplink | Complete |
| [3](./phase3_durable_object_sqlite_generator.md) | Business Aggregate and SQLite Generator | Complete |
| [4](./phase4_lifecycle_execution_visualizer.md) | Lifecycle Simulation and Execution Visualizer | Complete |
| [5](./phase5_deployment_and_user_portal.md) | Web App Blueprint and Deployment Experience | Complete |
| [6](./phase6_real_runtime_compiler.md) | Deterministic Runtime Compiler | Complete |
| [7](./phase7_production_runtime_and_delivery.md) | Production Runtime and Environment Delivery | Complete |
| [8](./phase8_runtime_observability.md) | Runtime Observability and Aggregate Operations | Complete |
| [9](./phase9_application_access_and_production_readiness.md) | Application Access and Production Readiness | Complete |
| [10](./phase10_database_as_code_cli_and_mcp.md) | Database-as-Code, CLI, and MCP | Complete |
| [11](./phase11_executable_data_operations.md) | Executable Data Operations | Complete |
| [12](./phase12_personal_developer_platform.md) | Personal Developer Platform | Complete |
| [13](./phase13_ai_native_project_workflow.md) | AI-Native Project Workflow | Complete |
| [14](./phase14_real_application_integration.md) | Real Application Integration | Complete |
| [15](./phase15_personal_data_backup_and_portability.md) | Personal Data Backup and Portability | Complete |
| [16](./phase16_composable_actor_extensions.md) | Composable Actor Extensions | Complete |
| [17](./phase17_module_versioning_and_safe_upgrades.md) | Module Versioning and Safe Upgrades | Complete |
| [18](./phase18_encrypted_backup_and_data_portability.md) | Encrypted Backup and Data Portability | Complete |
| [19](./phase19_multi_project_workspace_and_ai_discovery.md) | Multi-Project Workspace and AI Discovery | Complete |
| [20](./phase20_reusable_project_blueprints.md) | Reusable Project Blueprints | Complete |
| [21](./phase21_parameterized_blueprint_composition.md) | Parameterized Blueprint Composition | Complete |

## Current product boundary

Phases 1–9 provide the deployed Control Plane, compiler, runtime delivery, observability, access control, governance, and recovery foundation.

Phase 10 changes the primary authoring experience for personal use:

```text
repository files → CLI validation/plan → approved apply → immutable release
                                ↑
                           MCP for AI
```

Phase 10 establishes the stable file, CLI, and MCP contracts. Phase 11 turns authored schemas into safe, typed command and query operations for real applications and has passed governed live acceptance. Phase 12 productizes that foundation for daily personal-project use. Phase 13 binds AI-authored repository changes to deterministic review receipts before any approved Development apply. Phase 14 adds the trusted backend adapter and end-to-end readiness diagnostics required to connect a real application. Phase 15 adds local personal-data snapshots and non-destructive recovery rehearsal. Phase 16 adds reusable object modules that extend an existing Actor without duplicating its ownership boundary. Phase 17 adds immutable versions, customization detection, and additive-only module upgrades. Phase 18 adds authenticated encrypted archives for off-device portability and isolated recovery. Phase 19 organizes multiple independent projects into one metadata-only personal workspace and binds every AI mutation context to one explicitly selected project. Phase 20 turns a proven project structure into an immutable data-free blueprint that can generate a separately identified project through an exact approved plan. Phase 21 parameterizes Actor identities, partition keys, and module subsets while compiling the resulting SQLite schema and operations before approved creation.
