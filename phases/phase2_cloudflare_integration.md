# Phase 2: Cloudflare Developer Credentials & Integration

This phase specifies how developers link their Cloudflare account to the webapp securely, showing a beautiful non-technical connection flow instead of raw JSON API errors.

## 1. Credentials Input Interface
A sleek frosted card containing:
- **Cloudflare Account ID**: A text input with inline regex validation.
- **Cloudflare API Token**: A password-masked input with a "Reveal" icon.
  - Requires permissions for: `Account.Durable Objects`, `Account.Workers Scripts`, `Account.KV`, `Account.D1`.
- **Environment Context Settings**:
  - Ability to specify unique resource prefixes or separate configurations for **Dev**, **Staging**, and **Production** (e.g. `my-app-dev`, `my-app-staging`, `my-app-prod`) to guarantee strict data and service isolation.


---

## 2. The Connection Animation Sequence
When the user clicks **"Establish Secure Uplink"**:
1. The connection line between the "WebApp" card and the "Cloudflare Cloud" icon lights up with a flowing neon energy particle (using CSS path animations).
2. The system makes asynchronous check requests:
   - **Step 1: Authenticating Token...** (Status: Pulsing Amber dot)
   - **Step 2: Checking Durable Object capabilities...** (Status: Pulsing Amber dot)
   - **Step 3: Checking SQLite (D1) databases...** (Status: Pulsing Amber dot)
3. If successful:
   - Connection line glows solid **Vibrant Emerald**.
   - A success message reads: *"Lacify Engine Linked Successfully!"*
4. If failed:
   - The line turns **Crimson Red** with a slight shake animation.
   - The system displays a clear, friendly suggestion: *"Please verify your API Token permissions. Make sure Durable Objects write access is granted."*

---

## 3. Storage & Encryption (Client-Side)
- Credentials are saved in `localStorage` or `sessionStorage` encrypted with a user-defined password, or passed directly to the runtime backend.
- Option to "Clear Workspace Credentials" which cleans up local memory with a fade-out animation.
