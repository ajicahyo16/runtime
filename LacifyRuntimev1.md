Lacify Runtime v1 is optimized for request-response business systems.

## 🧠 Core Philosophy: Lacify vs. PostgreSQL

To understand Lacify, consider the difference between a traditional database (like PostgreSQL) and Lacify Runtime:

### PostgreSQL: The Archive Warehouse
* **Analogy**: A passive archive warehouse (**Warehouse → Shelves → Drawers → Documents**).
* **Role**: The database is passive; it only cares about storing, retrieving, and updating raw documents. It has no concept of your business rules or workflows.
* **Execution**: All business logic must be written and executed by external programmer code.

### Lacify: The Active Company (Actors)
* **Analogy**: A living company with active, responsible employees (**Cashier, Manager, Courier, Accountant**).
* **Role**: A "Payment" or "Order" is not just a row in a table. It is an **active "Actor" (Employee)** that is responsible for its own state machine and job lifecycle.
* **Lifecycle Flow**: An Actor wakes up, receives a job (e.g., *Create Payment*), transitions states (*Waiting → Received → Paid*), runs notifications, and goes back to sleep.
* **Execution**: Every Business Aggregate is an isolated Durable Object containing its own SQLite brain, running the active request-response lifecycle: **Wake → Validate → Execute → Persist → Update Summary → Respond → Sleep**.

---

## Supported domains:


POS Mobile
POS Admin
ERP
Inventory Management
CRM
Booking System
HR Management
Warehouse Management
Finance Management
Retail Management
Clinic Management
Restaurant Management

Characteristics:

Business Transactions
CRUD
Reports
Inventory
Financial Operations
Scheduling
Approval Workflow
Role Management

These systems fit naturally into the request → process → sleep lifecycle.

Out of Scope (Future Discussion)

The following systems require a different runtime strategy and are NOT part of Lacify Runtime v1:

Chat
Presence
Multiplayer
Collaborative Editor
Massive Live Dashboard
Large-scale WebSocket Infrastructure
Real-time Shared Documents

These workloads require long-lived connections and different actor lifecycle management, which will be designed in a future Runtime version.

AI Agent Instructions

When generating a Lacify Runtime application:

Treat each Business Aggregate as one Durable Object whenever appropriate (e.g., Outlet, Warehouse, Booking Calendar).
Store all operational business data in SQLite within the Durable Object.
Use R2 only for file storage.
Use Cloud Run only for heavy asynchronous processing.
Use BigQuery only for analytics and reporting at enterprise scale.
Generate summary tables (daily, monthly, yearly) to optimize reporting.
Ensure every request follows the lifecycle:
Wake
→ Validate
→ Execute
→ Persist
→ Update Summary
→ Respond
→ Sleep
Do not introduce WebSocket-based or long-lived runtime patterns unless explicitly building a future realtime runtime module.
Keep Workers stateless and place business rules exclusively inside Durable Objects.
Design for scalability by minimizing active duration and favoring short-lived request processing.

---

## 🛠️ Implementation Phases & Visual WebApp Blueprints

To build the visual, non-technical webapp, follow these phase-by-phase blueprints:

1. 🎨 **[Phase 1: UI/UX & Visuals/Animations Design](file:///Users/darlin/Documents/new-runtime/phases/phase1_ui_ux_visuals.md)**
   - Glassmorphism design system, Outfit typography, and the glowing Lifecycle Orb animations.
2. 🔌 **[Phase 2: Cloudflare Developer Credentials & Integration](file:///Users/darlin/Documents/new-runtime/phases/phase2_cloudflare_integration.md)**
   - Secure Account ID & API Token input flows with neon connection paths.
3. 📦 **[Phase 3: Durable Object & SQLite Database Generator](file:///Users/darlin/Documents/new-runtime/phases/phase3_durable_object_sqlite_generator.md)**
   - Mapping Business Aggregates into "Storage Actors" with internal SQLite and R2 assets.
4. ⚡ **[Phase 4: Lifecycle Execution Visualizer](file:///Users/darlin/Documents/new-runtime/phases/phase4_lifecycle_execution_visualizer.md)**
   - Requests visualized as moving cargo packets along a 7-step conveyor belt.
5. 🚀 **[Phase 5: Deployment & Non-Technical User Portal](file:///Users/darlin/Documents/new-runtime/phases/phase5_deployment_and_user_portal.md)**
   - Dual-Mode switcher (Developer Deck vs. User Space) with clean POS & Inventory interfaces.