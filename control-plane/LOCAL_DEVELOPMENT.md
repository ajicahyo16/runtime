# Local Control API

This workflow runs the React UI against the same Control API contract used for immutable releases.

1. Create `.dev.vars` at the repository root with a development-only key:

   ```sh
   SESSION_ENCRYPTION_KEY=<base64url value that decodes to 32 bytes>
   ```

   Generate one with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.

2. In one terminal, start the local Worker and D1 database:

   ```sh
   npm run control:dev
   ```

3. In another terminal, start the UI:

   ```sh
   npm run dev
   ```

Vite proxies `/api` to `http://127.0.0.1:8787`. The Releases page can then compile and verify immutable release artifacts locally. This local Worker is not a deployed Control API and must not be used for production credentials.

Runtime telemetry uses the public origin of the Control API request by default. If the Control API is behind a reverse proxy or tunnel, set `PUBLIC_BASE_URL` to its externally reachable HTTPS origin. A Cloudflare-deployed runtime cannot send telemetry to a `localhost` URL.
