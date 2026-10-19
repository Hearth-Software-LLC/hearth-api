# Hearth API

The shared TypeScript/Hono backend for the Hearth iOS apps (BigTable, Suffice, Sated, Caloma, Hearken), served at `https://api.hearthapps.com`. It runs locally on Node.js and deploys to Vercel's native Hono runtime. It combines the former Lifestyle API (reference data and banking) with the former BigTable API (meal planning, recipes, households, social), on one Supabase project.

## Implemented

| Route | Access | Behavior |
| --- | --- | --- |
| `GET /health` | Public | Liveness only; does not probe providers |
| `GET /openapi.json` | Public | Generated API contract, including bearer authentication |
| `GET /v1/me` | Supabase JWT | Returns the verified user subject |
| `GET /v1/brands/logo?domain=apple.com` | Anonymous or linked Supabase user + shared quota | Returns a direct Logo.dev image URL |
| `POST /v1/brands/logos` | Anonymous or linked Supabase user + shared quota | Up to 24 Logo.dev image URLs at once, by domain or known brand name |
| `GET /v1/foods/search?q=apple` | Anonymous or linked Supabase user + shared quota | Searches USDA FoodData Central summaries |
| `GET /v1/restaurants/menu?name=Chipotle%20Mexican%20Grill` | Anonymous or linked Supabase user + shared quota | Matches a place name to a chain and returns its menu with nutrition per serving |
| `POST /v1/restaurants/lookup` | Anonymous or linked Supabase user + shared quota | `{ "names": [...] }` (up to 12): which places are chains with published menus |
| `POST /v1/banking/link-token` | Linked Supabase user + shared quota | Creates a Plaid Link token; with `itemId`, one for update mode |
| `POST /v1/banking/connections` | Linked Supabase user + shared quota | Exchanges Link's public token, stores the sealed access token, returns the accounts |
| `GET /v1/banking/connections` | Linked Supabase user + shared quota | Lists the caller's connected banks |
| `POST /v1/banking/connections/{itemId}/sync` | Linked Supabase user + shared quota | Transactions added, changed and removed since the app's cursor, plus balances |
| `DELETE /v1/banking/connections/{itemId}` | Linked Supabase user + shared quota | Removes the item at Plaid and deletes its stored token |

All responses use `Cache-Control: no-store` and include `X-Request-ID`. Errors have the documented `{ "error": { "code", "message", "requestId" } }` structure. Logs include the matched route, status, duration, and request ID, not tokens, query strings, or provider error details.

## BigTable

BigTable's routes live under `/v1/bigtable/*`, with the same paths, request bodies and success responses as the old `api.bigtableapp.com/api/*` (swap the `/api/` prefix for `/v1/bigtable/`). Two things changed for clients:

- **Errors** use the API-wide shape `{ "error": { "code", "message", "requestId" } }`. The old message is now `error.message`; any extra fields an error carried (such as usage details on quota errors) stay at the top level.
- **Auth** is a Supabase access token from the Hearth project, verified locally against its signing keys. Anonymous sessions are refused (BigTable data needs an account). Place search (`/v1/bigtable/places/search`) now requires a signed-in user; it was public before.

Public routes: `GET /v1/bigtable/health` (database and configuration readiness), `GET /v1/bigtable/recipes/{id}/og` (published-recipe previews, CDN-cached) and `POST /webhooks/revenuecat` (RevenueCat's shared-secret `Authorization` header). `POST /v1/bigtable/maestro/reset` only works when `MAESTRO_RESET_TOKEN` is set; leave it unset in production.

The handlers in `src/bigtable/routes/` are the original Next.js route handlers, adapted to plain Web `Request`/`Response` (`src/bigtable/next-shim.ts`) and mounted by `src/bigtable/register.ts` from the table in `src/bigtable/route-table.ts`. They talk to Supabase with the secret key, so each one scopes its own reads and writes to the verified caller.

## Hearken study groups

Study groups live under `/v1/hearken/*` (they used to be CloudKit shares). A group follows one reading plan; members see each other's weekly progress, share highlights and reflections, reply in threads (two levels, with @mentions), react, and answer a weekly question whose answers stay hidden until you answer. Anonymous sessions are refused: groups need a Sign in with Apple account.

- **Storage:** `hk_*` tables from `supabase/migrations/20261019190345_hearken_study_groups.sql`, reached over a direct Postgres connection (`DATABASE_URL`, the Supabase transaction pooler on port 6543). RLS is on with no policies, so client keys can't reach them. Code: `src/hearken/service.ts` (queries, permissions, notifications) and `src/hearken/routes.ts`.
- **Notifications:** sent straight to APNs (`src/integrations/apns.ts`) with a .p8 key, so they work for native apps. Devices register with `PUT /v1/hearken/push-tokens`. Each member chooses per group: replies to their posts, mentions, every reply, the weekly question, and daily reading activity.
- **Scheduled work:** Vercel Cron calls `GET /internal/hearken/cron` daily at 13:00 UTC (7 AM in Utah in summer) with `CRON_SECRET`. It announces scheduled questions, tells people who haven't answered that answers are waiting (two days in, once), and purges anything deleted more than 30 days ago. A question that reaches its time between runs is announced by the first request that loads the group.
- **Invites:** 8-character codes; links are `https://api.hearthapps.com/hearken/join/<code>`, opened in Hearken through `apple-app-site-association` when `APPLE_APP_IDS` includes `BH8R3BX5WF.com.stephenwarren.hearken`.
- **Moving from CloudKit:** the owner's device posts the group to `POST /v1/hearken/groups/import` and leaves the returned migration token in the old CloudKit zone; each member's device claims its seat with `POST /v1/hearken/groups/claim`, which also hands back their posts and reactions.
- **Account deletion:** `DELETE /v1/hearken/me` hands owned groups to a leader (or the longest-standing member) and removes the person's posts, replies, answers, reactions and devices.

Tests in `tests/hearken/` run against a real database when `HEARKEN_TEST_DATABASE_URL` points at an empty scratch Postgres (they're skipped otherwise):

```sh
HEARKEN_TEST_DATABASE_URL=postgres://localhost/hearken_test npm test
```

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string for the Hearth project (transaction pooler) |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` | APNs auth key (.p8): its id, the team id, and the key's PEM text (`\n` escapes allowed) |
| `HEARKEN_APNS_TOPIC` | Hearken's bundle id; default `com.stephenwarren.hearken` |
| `CRON_SECRET` | Shared secret Vercel Cron sends to `/internal/*` (16+ characters) |
| `PUBLIC_BASE_URL` | Base of invite links; default `https://api.hearthapps.com` |

## Database

`supabase/` holds the Hearth project's full schema history (BigTable's migrations plus `plaid_connections`), the `expire-household-invitations` edge function and the local-development config. The production project is `kvhvsztvfpydhfpzicyy` (originally the BigTable project). Apply new migrations with `supabase db push` or the Supabase dashboard; never from the API at runtime.

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
| `PLAID_REDIRECT_URI` | Dashboard-registered HTTPS iOS Universal Link; no query, fragment, or embedded credentials. Use `https://api.hearthapps.com/plaid/oauth` |
| `APPLE_APP_IDS` | Comma-separated `TEAMID.bundle.id` iOS apps that may open `/plaid/*` links; default `BH8R3BX5WF.com.stephenwarren.suffice` |
| `PLAID_ENV` | `sandbox` (default) or `production`; never use production credentials in previews |
| `PLAID_CLIENT_NAME` | Display name in Link, 1-30 characters; default `Hearth` |
| `PLAID_COUNTRY_CODES` | Comma-separated Plaid country codes; default `US` |
| `FATSECRET_CLIENT_ID` | FatSecret Platform OAuth 2.0 client ID |
| `FATSECRET_CLIENT_SECRET` | Server-only FatSecret client secret |
| `FATSECRET_SCOPE` | OAuth scopes; default `premier` (needed by foods.search v5) |
| `RESTAURANT_CACHE_HOURS` | How long menus stay in the shared cache, 0–24; default 24 |
| `SUPABASE_URL` | Hearth Supabase project URL (BigTable data, bank connections) |
| `SUPABASE_SECRET_KEY` | Server-only Supabase secret key for that project |
| `PLAID_TOKEN_KEY` | 32-byte base64 key that seals Plaid access tokens |
| `ANTHROPIC_API_KEY` | BigTable AI meal plans, grocery lists and recipe import |
| `OPENAI_API_KEY` | BigTable recipe audio transcription |
| `GEMINI_API_KEY` | BigTable generated recipe images |
| `GOOGLE_PLACES_API_KEY` | BigTable dine-out place search |
| `REVENUECAT_WEBHOOK_SECRET` | Shared secret RevenueCat sends to `/webhooks/revenuecat` |
| `REVENUECAT_SECRET_API_KEY`, `REVENUECAT_PROJECT_ID` | RevenueCat REST access for subscriber sync and account deletion |
| `EXPO_ACCESS_TOKEN` | BigTable push notifications through Expo |
| `PORT` | Local server port; default 3000 |

Configure all three identity settings together and both Redis settings together. With Supabase, use asymmetric JWT signing keys (ES256 or RS256); legacy HS256 secrets are deliberately unsupported. Match issuer and audience to the project's actual access-token configuration. Obtain access tokens through your identity provider's supported iOS flow.

The token verifier checks signature, issuer, audience, expiry, issued-at, and a nonempty subject. Client-supplied app IDs do not grant permissions. Reference-data routes accept both anonymous and linked Supabase users. Banking rejects tokens whose verified `is_anonymous` claim is true; signing in with Apple through Supabase creates the durable identity required for financial connections.

Tests use generated signing keys, provider fixtures, and mocked quota-library responses. They do not need real credentials or make billable provider calls.

## Provider Behavior

### Logo.dev

The route validates a DNS domain (not a URL or IP), accepts `size` from 16 to 512 and `format=png|webp`, and returns a fixed-host CDN URL. `fallback=404` lets the iOS app display its own placeholder. The API does not fetch or store images, or assert that a logo exists.

The returned publishable key can be reused to request images directly. API quotas therefore limit URL resolution, **not CDN downloads**; configure provider controls and monitor CDN usage separately. Verify native-client compatibility with any key domain restrictions, and satisfy your plan's attribution and fair-use requirements before launch. Never substitute a secret `sk_` key.

`POST /v1/brands/logos` takes `{ items: [{ id, domain?, name? }], size?, format? }` (1–24 items, each with a domain or a name) and returns `{ items: [{ id, url, source }], provider, attribution }` in order, for one quota reservation. A domain wins when both are given. Name lookups (`img.logo.dev/name/…`) pick Logo.dev's closest-named brand, so send names only for known brands (Sated sends a restaurant's matched chain name, never a raw place name).

Reference: [Logo.dev image documentation](https://www.logo.dev/docs/logo-images/introduction). Name lookups: [Logo by brand name](https://www.logo.dev/docs/logo-images/name).

### USDA FoodData Central

Search accepts `q` (1-200 characters), `limit` (1-25, default 20), and the returned `nextCursor`. This first cursor is page-backed, limited to 999 pages: keep query and limit unchanged while paging; changing provider results may cause repeats or omissions. IDs are namespaced, such as `usda:123`.

Responses include summaries, source attribution, and fetch time. Nutrient details, serving-size normalization, barcode lookup, and personal diaries are not implemented. Do not infer nutrient values from these summaries.

Calls use a fixed upstream host, an eight-second deadline, a one-MiB response cap, validated provider data, and no automatic retries. Provider rate limits return `503 PROVIDER_QUOTA_EXCEEDED`, distinct from a local user `429 RATE_LIMITED`, with `Retry-After`. There is no shared result cache yet; repeated searches count against quotas and call USDA again.

USDA data are public domain/CC0; attribution is included. Obtain your own key rather than relying on the low-quota demo key. Reference: [FoodData Central API guide](https://fdc.nal.usda.gov/api-guide).

### FatSecret (restaurant menus)

`GET /v1/restaurants/menu?name=` takes a place's name as Apple Maps shows it ("Chipotle Mexican Grill"), finds the matching chain in FatSecret's brand catalog ("Chipotle": every word of the brand in the place's name, in order, with at least one word that isn't generic like "grill" or "pizza"), and returns up to 200 of its items, each with its servings: calories always, protein, carbs, fat and fiber when FatSecret has them (`null` means unknown, not zero). Places without a chain answer `200` with `hasMenu: false`, so the app can offer estimates instead. `POST /v1/restaurants/lookup` answers the same question for up to 12 names at once, for the "Full menu" badges on a nearby list; one failed name comes back `hasMenu: null` instead of failing the batch.

Reliability: the OAuth token (24 h) is shared through Redis and refreshed five minutes early, one request at a time; a rejected token is renewed once and the call retried. Each call has a six-second deadline, a 2 MiB cap and no redirects; network errors, timeouts and 5xx are retried once with jitter. FatSecret's in-body error codes are mapped (`13` renew, `12/14/21` → `503 PROVIDER_NOT_CONFIGURED`, `22` → `503 PROVIDER_QUOTA_EXCEEDED`). Brand matches are cached for a week (misses for a day), menus for `RESTAURANT_CACHE_HOURS`; a menu older than six hours is refreshed, and if FatSecret fails then the cached copy is served with `stale: true`. The cache is best effort: Redis trouble only means asking FatSecret again. Malformed foods are dropped individually.

**IP addresses.** FatSecret only accepts requests from IP addresses registered under your keys (Premier plans accept CIDR ranges). Vercel Functions don't have fixed outbound addresses unless you add Vercel's Static IPs, so either register Vercel's static egress IPs or a range FatSecret accepts for your plan. Until the IP is accepted, the routes answer `503 PROVIDER_NOT_CONFIGURED`.

**Terms.** Check FatSecret's terms for your plan on caching (their docs list only food and serving IDs as storable) and on attribution: responses carry `attribution: "Powered by fatsecret"` for the app to show.

### Quotas

Shared Redis counters reserve quota before provider access: 30 food/logo requests per user per operation per fixed minute window, plus 600 food searches per fixed hour window across the deployment. Restaurant requests share the per-user limit and have their own 1,200-per-hour FatSecret budget. Plaid Link-token creation has separate limits of five requests per user per fixed minute and 100 per fixed hour globally per Plaid environment. These are conservative starter settings in `src/services/quota.ts`, not a provider billing guarantee. Fixed windows allow boundary bursts. Size limits to your actual provider plan and account for other consumers of the same key.

Redis failures and the rate-limit library's fail-open timeout result are converted to `503`; no upstream request is made. Failed provider calls still consume reserved quota. User identifiers are hashed in Redis keys. Production and previews must use isolated provider credentials and Redis resources, with a common namespace across instances that share a budget.

### Plaid

Configure `PLAID_CLIENT_ID`, `PLAID_SECRET` and `PLAID_PRODUCTS` together, plus the identity and Redis settings. Products are deliberately not defaulted. `PLAID_REDIRECT_URI` is optional: only OAuth banks need it (Chase, Bank of America, Wells Fargo, Capital One and others), and then it must be a dashboard-registered HTTPS universal link served by the app's Associated Domains. The API serves that itself: `GET /.well-known/apple-app-site-association` lists `APPLE_APP_IDS` for `/plaid/*`, and `GET /plaid/oauth` is a small "go back to the app" page for when the link opens in a browser. Set `PLAID_REDIRECT_URI=https://api.hearthapps.com/plaid/oauth`, add the same address under Allowed redirect URIs in the Plaid Dashboard, and give the app the `applinks:api.hearthapps.com` Associated Domains entitlement.

Connections also need storage: `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (the Hearth project, also used by BigTable) and `PLAID_TOKEN_KEY` (32 bytes, base64; `openssl rand -base64 32`). The `plaid_connections` table is in `supabase/migrations/`. Without them the connection routes answer `503 STORAGE_NOT_CONFIGURED`.

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