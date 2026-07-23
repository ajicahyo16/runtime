# Phase 2: Secure Cloudflare Uplink

## Status

**Complete.** The Control Plane can connect to the owner's Cloudflare account and deploy isolated runtime resources.

## Objective

Provide a safe connection between Lacify and a personal Cloudflare account while keeping provider credentials out of browser persistence, URLs, logs, and generated bundles.

## Delivered

- [x] Account ID and scoped API-token connection flow.
- [x] Server-side Cloudflare credential verification.
- [x] Encrypted Uplink token envelopes stored by the Control Plane.
- [x] Opaque, expiring, revocable application sessions.
- [x] Connected/disconnected Uplink state in the console.
- [x] Separate Development, Staging, and Production resource naming.
- [x] Uplink replacement and revocation workflows.
- [x] Auditing for connection, disconnection, authentication, and credential rotation.
- [x] Redaction of authorization headers, cookies, tokens, and encryption material.

## Security rules

- Credentials are never stored in `localStorage` or `sessionStorage`.
- Browser forms submit credentials once over HTTPS and clear controlled state.
- Provider tokens are encrypted at rest; only the deployed Control API can decrypt them.
- Application identity, workspace membership, and Cloudflare Uplink identity are separate concerns.
- A valid Cloudflare account does not automatically grant access to an existing workspace.

## Acceptance evidence

- [x] The production console reports the linked Cloudflare account without returning its token.
- [x] Direct state-changing requests require an authenticated session and CSRF context.
- [x] Disconnecting Uplink prevents new deployments without stopping an already-running runtime.
- [x] No credential is embedded in the production JavaScript bundle or support diagnostics.

## Superseded concepts

The original client-side encrypted credential store was rejected. Production credentials are held only by the server-side Control Plane.

## Next dependency

Phase 3 compiles Business Aggregate definitions into Durable Object and SQLite runtime artifacts.
