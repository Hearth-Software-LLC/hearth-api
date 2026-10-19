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