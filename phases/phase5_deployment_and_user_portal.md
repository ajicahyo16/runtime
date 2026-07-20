# Phase 5: Deployment & Non-Technical User Portal

This phase outlines the final environment where end-users interact with the business systems (POS, ERP, CRM) without seeing any technical cloud configurations.

## 1. Dual-Mode Switcher: Developer vs. User
At the top header, a clean pill-switch toggles between:
- **Developer Deck**: Cloudflare status, database configurations, and the lifecycle visualizer.
- **User Space**: The actual clean business application interface.

---

## 2. User Space UI Design (Non-Technical)
The User Space consists of beautifully structured dashboards tailored for daily operations:

### POS Dashboard (Point of Sale)
- Large, touch-friendly product grid with glassmorphism hover animations.
- Simple checkout drawer that shows progress as:
  - *Processing Payment...* -> *Printing Receipt...* -> *Transaction Saved*.

### Inventory / Warehouse Manager
- A visual representation of stock levels using gradient progress bars.
- Simple, high-level alerts: *"Stock low on Espresso Beans (2kg left)"*.

### Approval Workflows
- A simple inbox where managers can swipe right to approve or left to reject pending purchase orders/requests.
- Success confirmation displays a satisfying confetti burst animation.

---

## 3. Simplified Deployment Orchestration
- **Target Environment Selection**:
  - Developers choose where to deploy using a quick-select: **Development**, **Staging**, or **Production**.
  - Visual indicators reflect the state of each environment (e.g., active versions, sync status).
- **Go Live Action**:
  - When the developer clicks **"Go Live"** for a selected environment:
    - The webapp bundles the Worker script and SQLite DO setup specifically configured for that environment.
    - Deploys it directly to the developer's Cloudflare namespace using the environment prefix (e.g., `dev.lacify.workers.dev`, `staging.lacify.workers.dev`, or custom production domain).
    - Generates separate public URLs and QR Codes for each active environment level.
    - Includes a **"Promote to Staging"** and **"Promote to Production"** visual pipeline animation where code/schema changes migrate safely up the chain.

