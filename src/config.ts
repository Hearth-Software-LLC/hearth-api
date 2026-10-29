import { z } from 'zod';
import { CountryCode, Products } from 'plaid';

const httpsUrl = z.url().refine((value) => new URL(value).protocol === 'https:');
const redirectUrl = httpsUrl.refine((value) => {
  const url = new URL(value);
  return !url.search && !url.hash && !url.username && !url.password;
});
// "TEAMID.bundle.id", comma-separated: the iOS apps allowed to open this domain's Universal
// Links (the Plaid OAuth return). Not secret; they appear in apple-app-site-association.
const appleAppIds = z.string().transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean))
  .pipe(z.array(z.string().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/)).max(20)
    .refine((values) => new Set(values).size === values.length));
const products = z.string().transform((value) => value.split(',').map((entry) => entry.trim()))
  .pipe(z.array(z.enum([Products.Transactions, Products.Auth, Products.Identity, Products.Liabilities, Products.Investments]))
    .min(1).max(5).refine((values) => new Set(values).size === values.length));
const countries = z.string().transform((value) => value.split(',').map((entry) => entry.trim()))
  .pipe(z.array(z.enum(CountryCode)).min(1).max(20)
    .refine((values) => new Set(values).size === values.length));

// A 32-byte AES-256 key, base64. Kept apart from the database so a database leak alone can't
// open the Plaid access tokens stored in it.
const tokenKey = z.string().trim().refine((value) => {
  try { return Buffer.from(value, 'base64').length === 32; } catch { return false; }
});

const configSchema = z.object({
  AUTH_ISSUER: httpsUrl.optional(),
  AUTH_AUDIENCE: z.string().min(1).optional(),
  AUTH_JWKS_URL: httpsUrl.optional(),
  UPSTASH_REDIS_REST_URL: httpsUrl.optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  RATE_LIMIT_PREFIX: z.string().min(1).default('hearth:quota:v1'),
  LOGO_DEV_PUBLISHABLE_KEY: z.string().startsWith('pk_').min(4).optional(),
  USDA_API_KEY: z.string().min(1).optional(),
  PLAID_CLIENT_ID: z.string().trim().min(1).optional(),
  PLAID_SECRET: z.string().trim().min(1).optional(),
  PLAID_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PLAID_CLIENT_NAME: z.string().trim().min(1).max(30).default('Hearth'),
  PLAID_PRODUCTS: products.optional(),
  PLAID_COUNTRY_CODES: countries.prefault('US'),
  PLAID_REDIRECT_URI: redirectUrl.optional(),
  APPLE_APP_IDS: appleAppIds.prefault('BH8R3BX5WF.com.stephenwarren.suffice'),
  SUPABASE_URL: httpsUrl.optional(),
  SUPABASE_SECRET_KEY: z.string().trim().min(20).optional(),
  PLAID_TOKEN_KEY: tokenKey.optional(),
  FATSECRET_CLIENT_ID: z.string().trim().min(1).optional(),
  FATSECRET_CLIENT_SECRET: z.string().trim().min(1).optional(),
  // Space-separated OAuth scopes. Restaurant menus use foods.search v5, which needs `premier`.
  FATSECRET_SCOPE: z.string().trim().regex(/^[a-z-]+( [a-z-]+)*$/).default('premier'),
  // How long restaurant menus may be kept in the shared cache. Check your FatSecret plan's
  // terms for how long its data may be cached; 0 turns the cache off.
  RESTAURANT_CACHE_HOURS: z.coerce.number().int().min(0).max(24).default(24),
  // Direct Postgres connection to the Hearth Supabase project, for Hearken study groups. Use the
  // transaction pooler URL (port 6543) in serverless deployments.
  DATABASE_URL: z.string().trim().regex(/^postgres(ql)?:\/\//).optional(),
  // Apple Push Notification service (token auth). APNS_PRIVATE_KEY is the .p8 file's PEM text;
  // literal "\n" sequences are accepted for one-line environment values.
  APNS_KEY_ID: z.string().trim().regex(/^[A-Z0-9]{10}$/).optional(),
  APNS_TEAM_ID: z.string().trim().regex(/^[A-Z0-9]{10}$/).optional(),
  APNS_PRIVATE_KEY: z.string().trim().includes('PRIVATE KEY').optional(),
  HEARKEN_APNS_TOPIC: z.string().trim().regex(/^[A-Za-z0-9.-]+$/).default('com.stephenwarren.hearken'),
  // Caloma's intercom wakes locked phones with VoIP pushes (PushKit), sent to this topic.
  CALOMA_VOIP_TOPIC: z.string().trim().regex(/^[A-Za-z0-9.-]+\.voip$/).default('com.stephenwarren.caloma.voip'),
  // And ordinary notifications (intercom broadcasts) to Caloma itself.
  CALOMA_APNS_TOPIC: z.string().trim().regex(/^[A-Za-z0-9.-]+$/).default('com.stephenwarren.caloma'),
  // Cloudflare Realtime TURN, for intercom calls away from home (Cloudflare dashboard ›
  // Realtime › TURN). Without them calls get STUN only.
  CLOUDFLARE_TURN_KEY_ID: z.string().trim().min(1).optional(),
  CLOUDFLARE_TURN_API_TOKEN: z.string().trim().min(1).optional(),
  // Hearth Ship's social pages (src/social). A Meta developer app (left in development mode: its
  // admins can use every permission on their own Pages without App Review). Its login redirect
  // URI is PUBLIC_BASE_URL + /oauth/meta/callback.
  META_APP_ID: z.string().trim().regex(/^\d{5,20}$/).optional(),
  META_APP_SECRET: z.string().trim().min(16).optional(),
  META_GRAPH_VERSION: z.string().trim().regex(/^v\d+\.\d+$/).default('v24.0'),
  // A Facebook Login for Business configuration id, for business-type apps (replaces the scope list).
  META_LOGIN_CONFIG_ID: z.string().trim().regex(/^\d{5,25}$/).optional(),
  // Seals the Pages' access tokens (like PLAID_TOKEN_KEY, a separate 32-byte base64 key).
  SOCIAL_TOKEN_KEY: tokenKey.optional(),
  // The Hearth account ids (comma-separated) allowed to use /v1/social.
  SOCIAL_OWNER_IDS: z.string().transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean))
    .pipe(z.array(z.uuid()).max(10)).prefault(''),
  // Hearth Studio: the team's owners (defaults to SOCIAL_OWNER_IDS), the Library's storage
  // budget (Supabase Free is 1 GB), the GitHub App that lists the apps, and the push topic.
  STUDIO_OWNER_IDS: z.string().transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean))
    .pipe(z.array(z.uuid()).max(10)).prefault(''),
  STUDIO_STORAGE_LIMIT_MB: z.coerce.number().int().min(50).max(1_000_000).default(1000),
  GITHUB_APP_ID: z.string().trim().regex(/^\d{1,12}$/).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().trim().includes('PRIVATE KEY').optional(),
  GITHUB_ORG: z.string().trim().regex(/^[A-Za-z0-9-]{1,39}$/).default('Hearth-Software-LLC'),
  STUDIO_APNS_TOPIC: z.string().trim().regex(/^[A-Za-z0-9.-]+$/).default('com.stephenwarren.hearthstudio'),
  // Affiliates and campaign links (src/affiliates). An App Store Connect API key (Users and
  // Access › Integrations › App Store Connect API; the Admin role, once, to request the analytics
  // reports) for campaign downloads and proceeds by ct= token, and the App Store provider id
  // (the pt= in campaign links: App Store Connect › Analytics › Campaigns shows it).
  ASC_KEY_ID: z.string().trim().regex(/^[A-Z0-9]{10}$/).optional(),
  ASC_ISSUER_ID: z.uuid().optional(),
  ASC_PRIVATE_KEY: z.string().trim().includes('PRIVATE KEY').optional(),
  ASC_PROVIDER_ID: z.string().trim().regex(/^\d{3,15}$/).optional(),
  // Where short links live (GET /go/<slug> on this API, or a site that forwards there).
  SHORT_LINK_BASE: httpsUrl.default('https://hearthapps.com/go'),
  // Credit sandbox purchases to affiliates (for testing only).
  AFFILIATES_ACCEPT_SANDBOX: z.enum(['true', 'false', '1', '0']).default('false')
    .transform((value) => value === 'true' || value === '1'),
  // Vercel Cron sends it as a bearer token to /internal/* jobs.
  CRON_SECRET: z.string().trim().min(16).optional(),
  // Where links the API hands out point (study group invites).
  PUBLIC_BASE_URL: httpsUrl.default('https://api.hearthapps.com'),
  // When true, server-paid features need the app's plan or Hearth+ (402 ENTITLEMENT_REQUIRED
  // otherwise): Plaid (Suffice), restaurant menus (Sated), creating and joining study groups
  // (Hearken). Off until the apps that sell those plans ship.
  ENFORCE_ENTITLEMENTS: z.enum(['true', 'false', '1', '0']).default('false')
    .transform((value) => value === 'true' || value === '1'),
}).superRefine((config, context) => {
  for (const group of [
    ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL'] as const,
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const,
    ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_PRODUCTS'] as const,
    // The Hearth Supabase project backs BigTable data and Plaid connection storage. Banking
    // additionally needs PLAID_TOKEN_KEY; without it, bank routes answer 503.
    ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'] as const,
    ['FATSECRET_CLIENT_ID', 'FATSECRET_CLIENT_SECRET'] as const,
    ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY'] as const,
    ['META_APP_ID', 'META_APP_SECRET'] as const,
    ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'] as const,
    ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY'] as const,
  ]) {
    const count = group.filter((name) => config[name] !== undefined).length;
    if (count > 0 && count < group.length) {
      context.addIssue({ code: 'custom', path: [group[0]], message: 'Configure the full group' });
    }
  }
});

export type Config = z.infer<typeof configSchema>;

export function readConfig(environment: Record<string, string | undefined> = process.env): Config {
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration fields: ${fields.join(', ')}`);
  }
  return result.data;
}