# Lifestyle API

A small TypeScript/Hono backend shared by an iOS app suite. Runs locally on Node.js and deploys to Vercel's native Hono runtime. No database is needed for the current reference-data lookups and Plaid Link-token creation.

## Implemented

| Route | Access | Behavior |
| --- | --- | --- |
| `GET /health` | Public | Liveness only; does not probe providers |
| `GET /openapi.json` | Public | Generated API contract, including bearer authentication |
| `GET /v1/me` | Supabase JWT | Returns the verified user subject |
| `GET /v1/brands/logo?domain=apple.com` | Anonymous or linked Supabase user + shared quota | Returns a direct Logo.dev image URL |
| `GET /v1/foods/search?q=apple` | Anonymous or linked Supabase user + shared quota | Searches USDA FoodData Central summaries |
| `POST /v1/banking/link-token` | Linked Supabase user + shared quota | Creates a Plaid Link token; with `itemId`, one for update mode |
| `POST /v1/banking/connections` | Linked Supabase user + shared quota | Exchanges Link's public token, stores the sealed access token, returns the accounts |
| `GET /v1/banking/connections` | Linked Supabase user + shared quota | Lists the caller's connected banks |
| `POST /v1/banking/connections/{itemId}/sync` | Linked Supabase user + shared quota | Transactions added, changed and removed since the app's cursor, plus balances |
| `DELETE /v1/banking/connections/{itemId}` | Linked Supabase user + shared quota | Removes the item at Plaid and deletes its stored token |

All responses use `Cache-Control: no-store` and include `X-Request-ID`. Errors have the documented `{ "error": { "code", "message", "requestId" } }` structure. Logs include the matched route, status, duration, and request ID, not tokens, query strings, or provider error details.

## Local Development

Use Node 24 LTS (`nvm use` if available), then:

```sh
npm ci
cp .env.example .env
npm run dev
```

The default address is `http://127.0.0.1:3000`. Change `PORT` if occupied. The local server binds only to loopback; use a secure tunnel for testing on a physical iPhone.

```sh
curl http://127.0.0.1:3000/health
npm run check
npm run build
npm start
```

Without credentials, health and OpenAPI work; protected routes reject requests. There is no shared API key or development authentication bypass.

## Configuration

Uncomment and replace the relevant settings in `.env`. Never commit it or put server secrets into an iOS binary. Missing integration settings disable that integration; partial identity/Redis/Plaid configuration or invalid settings fail startup without printing their values.

| Variable | Purpose |
| --- | --- |
| `AUTH_ISSUER` | Exact HTTPS issuer used in your provider's access tokens |
| `AUTH_AUDIENCE` | Audience accepted by this API |
| `AUTH_JWKS_URL` | Trusted provider's HTTPS JWKS endpoint |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint for shared quotas |
| `UPSTASH_REDIS_REST_TOKEN` | Server-only Redis credential |
| `RATE_LIMIT_PREFIX` | Environment-specific namespace; use separate Redis resources for production and previews |
| `LOGO_DEV_PUBLISHABLE_KEY` | Logo.dev CDN publishable `pk_` key, intentionally visible in returned URLs |
| `USDA_API_KEY` | Server-only data.gov API key for FoodData Central |
| `PLAID_CLIENT_ID` | Server-only Plaid client ID |
| `PLAID_SECRET` | Server-only Plaid secret for the selected environment |
| `PLAID_PRODUCTS` | Explicit comma-separated product list: `transactions`, `auth`, `identity`, `liabilities`, `investments` |
| `PLAID_REDIRECT_URI` | Dashboard-registered HTTPS iOS Universal Link; no query, fragment, or embedded credentials |
| `PLAID_ENV` | `sandbox` (default) or `production`; never use production credentials in previews |
| `PLAID_CLIENT_NAME` | Display name in Link, 1-30 characters; default `Lifestyle` |
| `PLAID_COUNTRY_CODES` | Comma-separated Plaid country codes; default `US` |
| `PORT` | Local server port; default 3000 |

Configure all three identity settings together and both Redis settings together. With Supabase, use asymmetric JWT signing keys (ES256 or RS256); legacy HS256 secrets are deliberately unsupported. Match issuer and audience to the project's actual access-token configuration. Obtain access tokens through your identity provider's supported iOS flow.

The token verifier checks signature, issuer, audience, expiry, issued-at, and a nonempty subject. Client-supplied app IDs do not grant permissions. Reference-data routes accept both anonymous and linked Supabase users. Banking rejects tokens whose verified `is_anonymous` claim is true; signing in with Apple through Supabase creates the durable identity required for financial connections.

Tests use generated signing keys, provider fixtures, and mocked quota-library responses. They do not need real credentials or make billable provider calls.

## Provider Behavior

### Logo.dev

The route validates a DNS domain (not a URL or IP), accepts `size` from 16 to 512 and `format=png|webp`, and returns a fixed-host CDN URL. `fallback=404` lets the iOS app display its own placeholder. The API does not fetch or store images, or assert that a logo exists.

The returned publishable key can be reused to request images directly. API quotas therefore limit URL resolution, **not CDN downloads**; configure provider controls and monitor CDN usage separately. Verify native-client compatibility with any key domain restrictions, and satisfy your plan's attribution and fair-use requirements before launch. Never substitute a secret `sk_` key.

Reference: [Logo.dev image documentation](https://www.logo.dev/docs/logo-images/introduction).

### USDA FoodData Central

Search accepts `q` (1-200 characters), `limit` (1-25, default 20), and the returned `nextCursor`. This first cursor is page-backed, limited to 999 pages: keep query and limit unchanged while paging; changing provider results may cause repeats or omissions. IDs are namespaced, such as `usda:123`.

Responses include summaries, source attribution, and fetch time. Nutrient details, serving-size normalization, barcode lookup, and personal diaries are not implemented. Do not infer nutrient values from these summaries.

Calls use a fixed upstream host, an eight-second deadline, a one-MiB response cap, validated provider data, and no automatic retries. Provider rate limits return `503 PROVIDER_QUOTA_EXCEEDED`, distinct from a local user `429 RATE_LIMITED`, with `Retry-After`. There is no shared result cache yet; repeated searches count against quotas and call USDA again.

USDA data are public domain/CC0; attribution is included. Obtain your own key rather than relying on the low-quota demo key. Reference: [FoodData Central API guide](https://fdc.nal.usda.gov/api-guide).

### Quotas

Shared Redis counters reserve quota before provider access: 30 food/logo requests per user per operation per fixed minute window, plus 600 food searches per fixed hour window across the deployment. Plaid Link-token creation has separate limits of five requests per user per fixed minute and 100 per fixed hour globally per Plaid environment. These are conservative starter settings in `src/services/quota.ts`, not a provider billing guarantee. Fixed windows allow boundary bursts. Size limits to your actual provider plan and account for other consumers of the same key.

Redis failures and the rate-limit library's fail-open timeout result are converted to `503`; no upstream request is made. Failed provider calls still consume reserved quota. User identifiers are hashed in Redis keys. Production and previews must use isolated provider credentials and Redis resources, with a common namespace across instances that share a budget.

### Plaid

Configure `PLAID_CLIENT_ID`, `PLAID_SECRET` and `PLAID_PRODUCTS` together, plus the identity and Redis settings. Products are deliberately not defaulted. `PLAID_REDIRECT_URI` is optional: only OAuth banks need it, and then it must be a dashboard-registered HTTPS universal link served by the app's Associated Domains (`apple-app-site-association`).

Connections also need storage: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (a server-only secret key) and `PLAID_TOKEN_KEY` (32 bytes, base64; `openssl rand -base64 32`), together. Apply `supabase/migrations/*_plaid_connections.sql` (`supabase db push`). Without them the connection routes answer `503 STORAGE_NOT_CONFIGURED`.

**What's stored, and what isn't.** The API keeps one row per Plaid item: the owner (the verified JWT subject), the item ID, the institution's name and the access token, sealed with AES-256-GCM using `PLAID_TOKEN_KEY` and bound to its owner and item. The table has row-level security on, no policies and no grants for `anon`/`authenticated`, so app-facing keys can't read it. Transactions, balances and sync cursors are never stored server-side: the app keeps its cursor and the data, and asks for changes when it wants them. There are deliberately no webhooks or job queues; sync is app-driven.

**Flow** (all bodies JSON, all calls with a non-anonymous Supabase access token):

1. `POST /v1/banking/link-token` with `{}` → `{ linkToken, expiresAt, plaidRequestId }`. Open Plaid Link (iOS SDK) with it.
2. `POST /v1/banking/connections` with `{ "publicToken": "public-…" }` → `201 { itemId, institution, accounts }`.
3. `POST /v1/banking/connections/{itemId}/sync` with `{ "cursor": "…" }` (omit it the first time) → `{ added, modified, removed, accounts, nextCursor, hasMore }`. Save `nextCursor`; call again while `hasMore`. Pending transactions are left out until they post. Amounts are positive cents with `isIncome`; `logoUrl` is Plaid's merchant logo and `merchantDomain` its website's domain (for Logo.dev).
4. `409 CONNECTION_NEEDS_REAUTH` means the bank wants the person to sign in again: `POST /v1/banking/link-token` with `{ "itemId": "…" }`, open Link in update mode, then sync.
5. `DELETE /v1/banking/connections/{itemId}` disconnects.

Only the person who connected an item can use it; other users get `404 CONNECTION_NOT_FOUND`. Client-provided user IDs, products, redirects and access tokens are rejected. Plaid calls use the official SDK with fixed hosts, eight-second deadlines per call, a 2 MiB response limit, no redirects and no automatic retries. Logs and errors never include credentials, Link tokens or access tokens. Errors: `429` user quota, `503` provider quota/configuration or storage, `502` upstream, `504` timeouts, `409` reauth, `404` unknown connection.

References: [Link tokens](https://plaid.com/docs/api/link/#linktokencreate), [token exchange](https://plaid.com/docs/api/items/#itempublic_tokenexchange), [transactions sync](https://plaid.com/docs/api/products/transactions/#transactionssync), [update mode](https://plaid.com/docs/link/update-mode/), [iOS Link](https://plaid.com/docs/link/ios/).

## Vercel Deployment

Import the repository into Vercel, use the Hono framework preset, and select Node 24. The default export in `src/index.ts` is the native entry point; no `/api` prefix or rewrite is required. The included build command compiles the local server too, but Vercel runs the Hono entry, not `npm start`.

Configure environment variables in the Vercel project separately for development, preview, and production. Deploy a preview first and verify `/health`, `/openapi.json`, authenticated requests, and quota rejection. Then attach a domain such as `api.yourdomain.com`.

Set usage alerts and billing safeguards for Vercel, Redis, and each provider. Confirm commercial-use eligibility and quotas for your hosting plan. Cloud deployment requires your Vercel account/project and provider configuration; this repository does not provision them.

Reference: [Hono on Vercel](https://vercel.com/docs/frameworks/backend/hono).

## Next Milestone

The Plaid connection lifecycle is implemented without webhooks or server-side transaction storage, by design (app-driven sync). Revisit webhooks only if background freshness matters more than keeping the server stateless.

Other follow-ups are a shared reference-data cache with bounded freshness, food details and normalized nutrients, CI deployment gates, provider live smoke tests, and a shared Swift client. The architecture document contains the broader plan.