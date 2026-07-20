# Phase 6: Real Runtime Compiler Backend & Local Schema Persistence

This phase transitions Lacify from an interactive visual simulator to a functional compiler backend. It introduces local schema persistence in YAML files and builds a real-time code generator in Node.js/Vite that compiles business aggregates into deployable Cloudflare Worker ZIP packages (Durable Objects + SQLite).

## Architectural Strategy

### 1. Local Contract Storage (YAML)
All configurations defined in the UI will persist locally inside the project workspace directory:
`/contracts/<aggregate-type-id>.yaml`

This guarantees schema definitions are version-controlled and not lost on browser reload.

### 2. Code Generation Engine
The backend will compile the YAML contract into code templates:
- `index.ts`: The main Durable Object implementation utilizing Cloudflare's new SQL API (`state.storage.sql`) to execute sqlite statements dynamically.
- `schema.sql`: Automated SQL DDL script containing the table structures (`CREATE TABLE`) mapped from the designer's Business Objects properties.
- `wrangler.json`: Configurations defining Durable Object bindings, migration details, and D1/SQLite mappings.
- `lacify-client.ts`: The compiled TypeScript SDK library containing strongly-typed command methods (e.g. `payOrder`) mapping directly to endpoint routing patterns.

### 3. Deployable Zip Archive Package
A **"Download Deployable Package"** action is triggered, compiling the assets and returning a ZIP bundle. Developers can extract this and run `npx wrangler deploy` to go live instantly.

---

## Deliverables & API Endpoints

- **[NEW] Endpoint: `GET /api/load-contracts`**: Reads `/contracts/*.yaml` files and returns configurations to populate the grid UI on console load.
- **[NEW] Endpoint: `POST /api/save-contract`**: Receives an aggregate layout payload from the UI designer and writes it to `/contracts/<id>.yaml`.
- **[NEW] Endpoint: `POST /api/compile-package`**: Compiles active YAML schemas and returns a downloadable ZIP archive containing the deployable worker.
