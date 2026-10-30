# Shared API for an iOS App Suite

## Recommendation

Build one small, shared backend with one public base URL, such as `https://api.yourdomain.com/v1`. Give each app focused routes under that URL and share authentication, integration adapters, and common infrastructure. With Plaid, Logo.dev, and food data providers in scope, its primary role is a backend-for-frontend: protect provider credentials, enforce access and quotas, and return stable contracts to the iOS apps.

Start with TypeScript, a lightweight HTTP framework such as Hono, and Vercel Functions using the Node.js runtime. Add managed PostgreSQL when durable state is needed. Simple food or logo lookups do not inherently need a database, but a production Plaid connection needs durable storage for ownership, encrypted access tokens, and processing state. Supabase is a practical starting point if you also need authentication; Neon is an alternative if you prefer a database-only service.

Keep this as a modular monolith: one repository and deployment, with clear internal modules. Do not start with microservices, Kubernetes, a custom authentication system, or a GraphQL layer unless the apps have a concrete need for them.

This recommendation assumes modest initial traffic, mostly short request/response operations, and no requirement to keep a server running continuously. Provider pricing and limits change; verify current plans before choosing them.

## One Endpoint or One Base URL?

I recommend **one base URL**, not one literal route that receives every operation.

For example:

```text
https://api.yourdomain.com/v1/me
https://api.yourdomain.com/v1/foods/search?q=apple
https://api.yourdomain.com/v1/brands/logo?domain=example.com
https://api.yourdomain.com/v1/banking/connections
```

All apps use the same backend, but routes remain easy to authorize, document, monitor, and test. Prefer shared domain routes when apps use the same capability. Use `/v1/apps/<app-id>/...` only for genuinely app-specific behavior; do not duplicate the food or banking integration for each app.

If a literal single HTTP route is a hard requirement, a GraphQL endpoint at `/graphql` is an option. It adds schema, resolver, query-cost, and caching complexity. A custom `/api` endpoint with an `action` field would be simpler initially but would recreate routing and validation inside one handler. Neither is necessary just to share a backend across apps.

## Initial Stack

| Layer | Suggested choice | Reason |
| --- | --- | --- |
| HTTP API | TypeScript + Hono | Small routing layer, runtime input validation, no frontend required |
| Hosting | Vercel Functions, Node.js runtime | Git-based deployment and request-driven execution |
| Identity | Supabase Auth or another managed OIDC provider | Avoid building passwords, account recovery, and token issuance |
| Provider integrations | Small typed adapters, official SDKs where suitable | Keep credentials and provider-specific behavior out of routes and Swift clients |
| Database, when needed | Managed PostgreSQL | Durable connection ownership, token storage, sync state, and domain data |
| Database access, when needed | Drizzle + the provider's serverless driver or pooled connection | Typed queries without exhausting database connections |
| Cache/rate-limit storage, when needed | Managed Redis-compatible service or suitable existing shared storage | Cross-instance caching and quota enforcement |
| Durable jobs, for Plaid sync | Managed queue/workflow service | Process webhook-triggered work with retries outside interactive requests |
| File storage, only if needed | Private object storage with signed upload/download URLs | Keep large files out of API functions and the database |
| Contract | OpenAPI, generated from validated route schemas where practical | A documented contract usable by every Swift client |

Use the Node.js runtime first. An edge runtime introduces compatibility constraints and does not automatically make database-backed requests faster. Put compute near the database where the selected hosting plan allows it.

An API-only project does not need Next.js. Add it only if a web dashboard or website is also part of the product.

## Repository Layout

```text
hearth-api/
  src/
    app.ts                   # Framework setup and route mounting
    index.ts                 # Native Vercel Hono entry point
    server.ts                # Local Node.js HTTP server
    routes/
      v1/
        me.ts
        preferences.ts
        foods.ts
        brands.ts
        banking.ts
        apps/
          <app-id>/
            entries.ts
      webhooks/
        plaid.ts
    middleware/
      auth.ts
      errors.ts
      request-id.ts
    services/
      accounts.ts
      <app-domain>.ts
    integrations/
      plaid.ts
      logo-dev.ts
      <food-provider>.ts
    jobs/
      plaid-sync.ts
    db/
      schema.ts
      client.ts
    contracts/
      common.ts
  migrations/
  tests/
  package.json
  vercel.json
```

This is illustrative, not a requirement to create every file immediately. Vercel's native Hono support uses the default export in `src/index.ts`; routes keep their `/v1/*` paths without an `/api` prefix. Keep route handlers thin: validate input, establish identity, call the domain service, and return a consistent response.

Organize business logic by domain, not by copying an entire backend for each app. An app-specific module should own its rules; common middleware should own cross-cutting concerns.

## Integration Design

Use this request path: **iOS client -> validated domain route -> domain service -> provider adapter**. The service decides authorization, caching, and business behavior; the adapter handles provider authentication, requests, and response translation. Keep adapters small and concrete rather than building a universal plugin framework.

Never expose a generic proxy that accepts arbitrary provider URLs, API paths, or credentials from a client. Allow only defined operations and fixed upstream hosts. This prevents the API becoming an open proxy, an SSRF entry point, or an unrestricted way to spend your provider budget.

Define request deadlines, bounded retries for safe operations, and consistent errors such as `UPSTREAM_UNAVAILABLE` or `RECONNECT_REQUIRED`. Distinguish your own client quota failures from provider outages or exhausted provider quotas. Do not leak provider tokens or raw error payloads. Track provider latency, failures, and billable usage separately from API request counts.

### Plaid

Treat Plaid as a stateful financial integration, not a simple request proxy:

1. An authenticated client calls `POST /v1/banking/link-token`; the server creates a Link token for that user and the required Plaid products.
2. The iOS app opens the official Plaid Link SDK. Bank credentials stay in that flow, not in your API or app's own forms.
3. The client sends the returned public token to `POST /v1/banking/connections`. The server exchanges it and stores the resulting access token encrypted at rest, associated with the authenticated owner and Plaid Item ID. Never return that access token to iOS.
4. Plaid calls a dedicated route such as `POST /webhooks/plaid`. Verify it using Plaid's documented verification mechanism, including body integrity and freshness checks. Persist accepted work durably before acknowledging it; process it with retryable jobs and tolerate duplicate or out-of-order notifications.
5. For transaction data, jobs use the applicable Plaid sync API, persist its cursor, and apply additions, modifications, and removals consistently. Serialize sync work per connection or otherwise prevent competing cursor updates. The client reads your stored results rather than triggering a full provider sync each time it opens a screen.

Store only the financial data the product needs. Keep financial responses out of shared caches and logs. Encrypt access tokens with a managed key or server-side encryption key kept separately from the database, restrict decryption to the required code paths, and plan key rotation. Keep sandbox and production credentials and data separate.

Support reconnect/update-mode flows, connection status, and disconnect. Disconnect should remove the Plaid Item through the supported provider operation and delete or retain local data according to an explicit policy. A shared suite account does not automatically authorize every app to read its bank data; enforce the intended consent and permissions on the server.

Select only the Plaid products needed by the app and confirm their billing and production-access requirements. Transaction sync is an example, not a reason to ingest transactions if the app only needs another capability.

### Logo.dev

First decide whether the API must serve image bytes or only resolve logo metadata and URLs. If Logo.dev's current product supports client-visible publishable keys and direct image delivery, that can avoid relaying every image through a function. Publishable keys are not authorization for your private API; secret management keys must remain server-side.

Use `GET /v1/brands/logo?domain=example.com` if centralized lookup, provider substitution, or policy enforcement is useful. Validate and normalize domains and allowlist supported size/format options. If proxying images, fetch only the fixed provider host, bound response size and duration, and set appropriate content-type and cache headers.

Verify Logo.dev's current key model, attribution, caching, and redistribution terms before choosing direct delivery, proxying, or storing logos. Do not introduce an image storage service merely to duplicate the provider's CDN.

### Ad copy for Hearth Ship (Claude)

`POST /v1/marketing/ad-copy` writes ad copy for Hearth Ship's Social tab: two short lines for the ad image, a headline, the primary text and a button, in a few versions (`src/marketing/ad-copy.ts`). Hearth+ only (`createHearthPlusGate`, off unless `ENFORCE_ENTITLEMENTS`), with its own quota (`marketing`, 30 an hour per account).

The request carries the app's App Store listing, the campaign brief, audience and tone, and the platforms the ads run on with their character limits, so changing a limit needs no deploy. Claude (Sonnet by default, `MARKETING_MODEL` to change it) answers through a forced tool call. Every field is checked against the tightest limit among the platforms; anything too long gets one follow-up call that shortens only those fields, and whatever is still too long comes back listed in `tooLong`, never cut. Nothing is stored; only status, latency, token counts and the app id are logged, and no account id goes to Anthropic.

Hearth Ship signs in with `scripts/dev-session.ts` (`npm run dev-session`), which makes a one-time magic link with the secret key and redeems it at once, for an account chosen from Test Plans. It grants nothing beyond what holding the secret key already does.

### Social pages for Hearth Studio

`/v1/social/*` lets Hearth Studio (Mac, iPhone, iPad) run Hearth Software's own social accounts (`src/social`): posts (drafts, scheduled, published), an inbox of comments, and numbers. Everything belongs to the caller's team (see Hearth Studio below), and connecting accounts or posting needs that permission.

- **Facebook Pages and Instagram** go through Meta's Graph API (`meta.ts`). `POST /v1/social/connections/meta/start` returns a Facebook login link; `GET /oauth/meta/callback` swaps the code for a long-lived token, saves every Page the login manages (and its linked Instagram account) with its Page token sealed by `SOCIAL_TOKEN_KEY`, and sends the browser to `hearthship://social/connected`. The Meta app stays in development mode: the people with a role on it can use every permission on their own Pages without App Review.
- **Every other platform is hand-off.** Hearth Ship prepares the post, you post it in the platform's app, then `POST /v1/social/targets/{id}/posted` records its link. Their numbers arrive as CSV exports that Hearth Ship reads and sends to `POST /v1/social/metrics/import`.
- **Publishing:** "Post now" is a schedule of now. The request publishes what it can (an Instagram video still processing after 20 seconds stays `processing`); pg_cron calls `GET /internal/social/cron` every 5 minutes (`20261029000100_social_pages_media_and_cron.sql`, with `CRON_SECRET` in Vault as `hearth_api_cron_secret`) to publish what's due, finish processing videos, and sync posts and comments (every 15 minutes) and numbers (every 6 hours). A target is claimed before it's published, so two runs can't post it twice.
- **Media** lives in the private `social-media` bucket: `POST /v1/social/media` gives Hearth Studio a signed upload URL, and Meta fetches each file from a signed URL when the post goes out. A post can also use a Library file, as `library/<team>/...`.
- **Reply suggestions:** `POST /v1/social/comments/{id}/suggest` asks Claude for three replies (Hearth+, `marketing` quota), with the comment, its thread and the post's text.

Tables: `social_connections`, `social_posts`, `social_targets` (one per account a post goes to, plus posts found on an account), `social_comments`, `social_metrics` (by day; a post's are its totals as of that day). Tests: `SOCIAL_TEST_DATABASE_URL=postgres://localhost/social_test npm test`.

### Hearth Studio

`/v1/studio/*` and `/v1/library/*` (`src/studio`) are the rest of Hearth Studio. Every call works as the caller's team (`gate.ts`): `SOCIAL_OWNER_IDS` (or `STUDIO_OWNER_IDS`) are the Hearth Software team's owners, and anyone else is let in with an invite. Members have three permissions: post (posts, replies, the Library, campaigns, designs), plans, and accounts (connecting social accounts).

- **Team** (`team.ts`): `GET/PATCH /v1/studio/me` (name, which pushes), `GET /v1/studio/members`, owners' `PATCH/DELETE /v1/studio/members/{userId}` and `POST /v1/studio/invites` (8 characters, a week, one use), and `POST /v1/studio/invites/{code}/join`. `POST/DELETE /v1/studio/devices` registers APNs tokens.
- **Plans** (`plans.ts`): `GET /v1/studio/accounts?search=`, `GET /v1/studio/accounts/{id}`, `PUT` and `DELETE /v1/studio/accounts/{id}/plans/{plan}`. These are `scripts/set-entitlements.ts` as an API: RevenueCat grants, then the `subscriptions` row is rewritten. Bought plans can't be removed (409 `PLAN_BOUGHT`). Every change is in `plan_grants_log`.
- **The Library** (`library.ts`): screenshots, mockups, ad images, uploads and app icons in the private `library` bucket, at `<team>/<app>/<kind>/<sha256>.<ext>`, so a file is stored once. Uploading is `POST /v1/library/uploads` (a signed upload URL, or `exists`), a PUT to it, then `POST /v1/library/assets`. Clients sync with `GET /v1/library/assets?since=<cursor>`; deletions come through as `deleted: true`. Screenshot runs (`POST /v1/library/runs`, then `/complete`) keep the team's last `keep_runs` (2) per app, device and appearance. Older ones are removed unless a post, campaign or design uses them. `GET /v1/library/usage` reports storage use.
- **Campaigns and designs** (`documents.ts`): ad campaigns and Store Studio designs are JSON documents with a version. Saving sends the version it was based on, and a stale save answers 409 with the current one.
- **Apps** (`github.ts`): `GET /v1/studio/apps` lists the repos in `GITHUB_ORG` that have a `hearth-app.json` (`key`, `name`, `accent`, `icon`, `appStoreId`, `bundleId`), through a GitHub App, cached for 10 minutes. Each icon is copied into the Library.
- **Pushes** (`notify.ts`): the social cron also pushes due hand-off posts, posts that failed, and new comments (one push for a batch) to the members who want each.

Tables: `studio_teams`, `studio_members`, `studio_invites`, `plan_grants_log`, `studio_devices`, `library_runs`, `library_assets`, `marketing_campaigns`, `store_designs` (`20261029100000_studio_team.sql`, `20261029100100_studio_library.sql`). Tests: the same `SOCIAL_TEST_DATABASE_URL`.

### Collections (Hearth Content)

Collections are Hearth Content items people browse and download in the apps (`src/content`, `20261031090000_content_collections.sql`). A content type is a Collection when its definition has `listing.downloadable`; learning modules are, counted in lessons. Help articles and What's New are not.

- **Listing:** each version carries a listing (title, about, up to three categories, Free or Plus, and a cover), saved with `PUT /v1/content/entries/{id}/listing` under the same revision rule as the draft and reviewed with it. Publishing checks that it has a title and a cover, and that image crops are big enough. `GET /v1/content/covers` is the one list of cover templates, palettes and author colors both renderers use.
- **Storage:** free bundles go to the public `hearth-content` bucket as before; Plus bundles go to the private `hearth-content-plus` bucket. `POST /v1/content/{app}/items/{id}/download` returns the public URL for free items, or a 10-minute signed link for Plus after checking for `hearth_plus` or `<app>_plus` (own or the household organizer's; always signs when `ENFORCE_ENTITLEMENTS` is off). Nothing records who downloaded what.
- **Catalog:** `GET /v1/content/{app}/catalog` stays as it was for older builds and leaves Plus items out. `?format=2` adds each item's listing, access, full sha256, download size (bundle plus the images it uses), author and rating, plus the app's featured list and its authors. Its ETag covers the catalog, shared, featured and authors versions.
- **People in the apps** rate (`PUT …/items/{id}/rating`, one rating each) and report (`POST …/items/{id}/report`) with their normal Hearth token; they don't need the content team. Both are rate-limited. A rating recounts the item and refreshes its entry in the catalog in the same transaction; the catalog shows ratings from five.
- **The team** edits author profiles (`/v1/content/authors/me`), sees their Collections (`/authors/me/collections`), features up to five items per app (`/catalogs/{app}/featured`, publishers) and reviews reports (`/reports`, `/reports/{id}/dismiss`, publishers). Reports never show who sent them.

- **Catalog storage:** each `content_catalogs` row keeps `entries` exactly as format 1 serves it (free items, today's fields), so an older API build still serves what it always did, and `entries_v2` with every item. Ratings and featured changes bump `ratings_version` and `featured_version`, which only the format-2 ETag uses; `version` changes only when content does.
- **Deploying:** 1) apply `20261031090000_content_collections.sql` (it only adds tables and columns; safe with the old API live), 2) deploy this API, 3) apply `20261031100000_learning_module_listing_after_deploy.sql`, which makes learning modules Collections. An API from before Collections returns 500 on that type definition, so undo step 3 before rolling the API back (the migration's header has the SQL).

Account deletion removes the person's ratings (recounting each item) and reports, and makes their author profile anonymous ("Former author", no bio or photo).

### Food Data Providers

Start with one provider selected for the actual workflow: nutrient reference data, packaged-food/barcode lookup, and recipe search are different requirements. Add another only for a demonstrated coverage gap.

Expose stable routes such as `GET /v1/foods/search`, `GET /v1/foods/{id}`, and, if needed, `GET /v1/foods/by-barcode/{barcode}`. Preserve barcode leading zeros. Include provider provenance in identifiers or mappings so records from different catalogs cannot collide.

Normalize serving sizes, units, and nutrient bases explicitly, such as per serving versus per 100 grams. Distinguish missing nutrient data from zero and preserve source attribution and freshness. Use response fixtures and adapter tests to catch provider schema changes without silently changing values presented by iOS.

Cache permitted public catalog results using keys that include provider, normalized query or identifier, locale, and relevant options. Choose TTLs based on freshness needs and provider terms. Do not cache personal food diaries as public data, and do not assume every provider permits long-term storage or redistribution.

### Database Scope

A database is your durable state layer, not a generic database endpoint for the apps. Expose domain operations, never client-supplied SQL or unrestricted table access. Start without it for a lookup-only prototype if practical; add it before storing Plaid connections or promising durable user workflows.

Initial Plaid-related storage can be limited to connection ownership and status, encrypted tokens, sync cursors, and durable job/deduplication state. Add transactions, preferences, or food diaries only when required. A cache is disposable and should not be the only copy of connection credentials or synchronization state.

## Identity and Data Boundaries

Use one identity system across the suite if the product should offer a shared account. Each iOS app signs in through the provider's supported flow and sends a short-lived bearer token. The API verifies the token's signature, issuer, audience, and expiry, then derives the user ID from the verified token.

Shared identity does not automatically mean shared login state across separate iOS apps. Keychain sharing requires compatible signing and access-group configuration, and the sign-in experience should be designed explicitly. For browser-based OAuth flows, use Authorization Code with PKCE.

Keep these concepts separate:

- **User:** the authenticated person.
- **App:** the product making the request.
- **Resource owner:** the user or group allowed to access a particular record.
- **Entitlement:** permission to use a paid or restricted capability, if applicable.

A route app ID or `X-App-ID` header is useful for namespacing and analytics, but it is client-supplied metadata, not proof of identity or permission. Never authorize sensitive access from it alone. If access must depend on a specific app, establish that through validated identity claims or an appropriate app-verification flow.

When persistence is needed, start with user ownership references and the domain-specific tables required by the first workflow; add `user_preferences` only if preferences are stored. Add `user_id` to owned records and `app_id` only where the same table genuinely stores separate per-app data. Scope every read and write by authorized ownership, including lookups by record ID. Use database constraints to enforce uniqueness and relationships.

If using Supabase, explicitly decide whether clients can access its database API. For an API-only design, restrict that path appropriately; do not assume your HTTP handlers protect a separately exposed database. Privileged database credentials can bypass row-level security, so server-side ownership checks remain necessary.

Do not add organization tenancy until the product needs it. If shared household or team data is expected soon, model memberships and resource ownership explicitly rather than treating an app ID as a tenant.

## API Contract for iOS

- Version the public contract under `/v1`. Prefer additive changes; keep older contracts working while older app releases remain supported.
- Use normal HTTP semantics and status codes. Return objects directly for single resources and `{ "items": [], "nextCursor": null }` for lists.
- Standardize errors, for example `{ "error": { "code": "RESOURCE_NOT_FOUND", "message": "Resource not found", "requestId": "..." } }`. Never expose stack traces or secrets.
- Validate JSON bodies, path parameters, and query strings at runtime. Define payload-size and pagination limits.
- Use stable identifiers and UTC timestamps encoded as RFC 3339 strings. Document the timestamp format for Swift decoding.
- Support cursor pagination for growing collections and idempotency keys for retryable creates with meaningful side effects.
- Use transactions and database-backed uniqueness for idempotency. Process memory is not shared or durable across serverless instances.
- Define conflict behavior for offline edits. If needed, use a record revision with conditional updates so stale writes do not silently overwrite newer data.

Create a small shared Swift networking package once two apps need the same client behavior. It should own the base URL, token attachment, decoding, token refresh coordination, and error mapping. Keep domain models app-specific unless they are truly shared.

Retry transient failures with bounded exponential backoff and jitter, respecting `Retry-After`. Do not blindly retry non-idempotent writes. Store user credentials in the Keychain; never embed a server secret in an iOS binary. CORS is not access control for native clients.

## Security and Operations

- Store database credentials and signing secrets in hosting environment variables, with separate development, preview, and production values.
- Use separate non-production resources for previews; never let arbitrary preview deployments mutate production data.
- Apply per-user and, where appropriate, per-IP rate limits through shared storage or a managed service. An in-memory limiter is not reliable across function instances.
- If anonymous access is needed, define explicit anonymous identities and tighter quotas. A static API key distributed with an app is not a secret.
- Consider Apple App Attest for valuable anonymous or abuse-prone operations. It supplements user authorization and rate limiting; it does not replace them.
- Log request IDs, route, app metadata, status, duration, and error category. Avoid logging tokens, request bodies, or sensitive personal data by default.
- Provide liveness and readiness checks without publishing internal configuration. Alert on elevated error rates and unexpected usage.
- Keep database migrations committed and run them through a controlled release step, not on every request or function startup. Use backward-compatible migrations during rolling deployments.
- Enable backups and verify restoration. Choose a region and retention policy appropriate to the data being collected, especially if the apps handle health or other sensitive information.
- Plan account deletion and export across the entire suite. Deleting an identity alone does not necessarily remove its domain data or stored files.

If the suite sells digital subscriptions, verify App Store transactions server-side and process App Store Server Notifications with signature verification and idempotency. Decide explicitly which entitlements are shared across apps; shared identity alone does not make purchases transferable.

## Keeping It Cheap

The initial cost drivers are usually database service, function usage, bandwidth, storage, authentication, and any external APIs. A free tier can support development or a small launch, but should not be treated as a production reliability guarantee.

1. Keep handlers short and stateless; reuse a compatible database client and use provider-supported pooling or a serverless driver.
2. Upload files directly to object storage using short-lived signed URLs. Validate authorization before issuing them and constrain size and content type.
3. Cache public, non-user-specific responses where useful. Mark private account responses appropriately so shared caches cannot leak them.
4. Bound expensive operations, outbound requests, and third-party API usage with timeouts, quotas, and provider billing safeguards where available.
5. Add usage alerts and track cost per app. Confirm whether the hosting plan permits your intended commercial use, what happens at quota exhaustion, and which controls actually cap spending.

For these integrations, third-party charges may exceed hosting costs. Set provider-specific user quotas and global usage limits, cache food/logo results only where permitted, and avoid unnecessary Plaid refreshes. Reserve expensive-operation quota atomically in shared storage before issuing upstream calls; alerts alone do not stop concurrent requests from spending money. Keep webhook ingestion and disconnect/recovery operations available when ordinary lookup quotas are exhausted.

Vercel is a reasonable starting point for low-volume HTTP workloads, but check function duration, cold-start behavior, regional availability, request limits, and pricing before launch. No always-on process is required, but the API remains available subject to provider behavior and limits.

For long-running work, scheduled processing, or durable retries, use a managed queue/workflow service and a worker. Never rely on unfinished work continuing after an HTTP response. Realtime connections may require a separate managed service.

Keep the core app independent of Vercel's adapter so it can later run on a small always-on Node.js service. Revisit hosting when measurements show that latency, predictable fixed pricing, or workload duration would benefit from that change.

## First Implementation Milestone

The initial implementation now includes the local server and Vercel entry point, generated OpenAPI, JWT authentication, shared Redis quotas, Logo.dev CDN URL resolution, USDA food-summary search, and `POST /v1/banking/link-token` through the official Plaid SDK. See [README.md](README.md) for configuration and current limitations. Plaid public-token exchange and the durable connection lifecycle, shared result caching, and nutrient normalization remain follow-up work; the implementation does not accept bank access tokens or store financial data yet.

Start with one app and one real integration, not a generalized platform:

1. Set up the TypeScript API, runtime validation, test runner, and local environment.
2. Add a liveness route, authentication middleware, and one food lookup or logo-resolution route with its provider adapter, quotas, and explicit timeout.
3. Test input validation, provider failures and rate limits, response mapping, cache isolation, and credential redaction. Deploy an isolated preview and exercise it from iOS.
4. Before adding Plaid token exchange and bank-data access, introduce durable storage and a job mechanism. Complete the sandbox Link/exchange flow, verified webhook ingestion, the required product workflow, reconnect, and disconnect.
5. Test cross-user and cross-app access, duplicate webhooks, retries, interrupted sync, and disconnect cleanup. Measure latency, provider usage, and database connections before production rollout.
6. Add the second app using the same authentication and networking contract. Extract common business behavior only where actual overlap appears.

Before implementing, settle which Plaid products and food providers are needed, whether accounts and purchases are shared, whether the apps need offline synchronization, and what sensitive data will be stored. Confirm provider licensing and production approval requirements. Those product decisions have more impact on the data model than the hosting choice.

**Bottom line:** one shared REST API and deployment, managed identity, and small provider adapters behind stable domain routes. Keep lookup-only features lean; add PostgreSQL and durable jobs for Plaid and other stateful workflows. This keeps the initial system inexpensive and understandable while preserving a practical path off Vercel later.