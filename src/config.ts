import { z } from 'zod';
import { CountryCode, Products } from 'plaid';

const httpsUrl = z.url().refine((value) => new URL(value).protocol === 'https:');
const redirectUrl = httpsUrl.refine((value) => {
  const url = new URL(value);
  return !url.search && !url.hash && !url.username && !url.password;
});
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
  RATE_LIMIT_PREFIX: z.string().min(1).default('lifestyle:quota:v1'),
  LOGO_DEV_PUBLISHABLE_KEY: z.string().startsWith('pk_').min(4).optional(),
  USDA_API_KEY: z.string().min(1).optional(),
  PLAID_CLIENT_ID: z.string().trim().min(1).optional(),
  PLAID_SECRET: z.string().trim().min(1).optional(),
  PLAID_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PLAID_CLIENT_NAME: z.string().trim().min(1).max(30).default('Lifestyle'),
  PLAID_PRODUCTS: products.optional(),
  PLAID_COUNTRY_CODES: countries.prefault('US'),
  PLAID_REDIRECT_URI: redirectUrl.optional(),
  SUPABASE_URL: httpsUrl.optional(),
  SUPABASE_SECRET_KEY: z.string().trim().min(20).optional(),
  PLAID_TOKEN_KEY: tokenKey.optional(),
}).superRefine((config, context) => {
  for (const group of [
    ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL'] as const,
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const,
    ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_PRODUCTS'] as const,
    ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'PLAID_TOKEN_KEY'] as const,
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