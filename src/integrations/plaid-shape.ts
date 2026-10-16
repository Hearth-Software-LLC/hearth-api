import { z } from 'zod';
import { ApiError } from '../errors.js';

/**
 * Validates Plaid's responses and reduces them to what the apps use: amounts in whole cents,
 * always positive, with `isIncome` saying which way the money went (Plaid: positive = out).
 */

const accountSchema = z.object({
  account_id: z.string().min(1),
  name: z.string(),
  official_name: z.string().nullish(),
  mask: z.string().nullish(),
  type: z.string(),
  subtype: z.string().nullish(),
  balances: z.object({ current: z.number().nullish(), available: z.number().nullish() }),
});

const transactionSchema = z.object({
  transaction_id: z.string().min(1),
  account_id: z.string(),
  amount: z.number(),
  date: z.string(),
  authorized_date: z.string().nullish(),
  name: z.string(),
  merchant_name: z.string().nullish(),
  pending: z.boolean(),
  logo_url: z.string().nullish(),
  website: z.string().nullish(),
  personal_finance_category: z.object({ primary: z.string(), detailed: z.string().nullish() }).nullish(),
  location: z.object({
    address: z.string().nullish(), city: z.string().nullish(), region: z.string().nullish(),
    postal_code: z.string().nullish(), lat: z.number().nullish(), lon: z.number().nullish(),
  }).nullish(),
});

export const exchangeSchema = z.object({ access_token: z.string().min(1), item_id: z.string().min(1) });
export const accountsSchema = z.object({
  accounts: z.array(accountSchema),
  item: z.object({ institution_id: z.string().nullish() }),
});
export const institutionSchema = z.object({ institution: z.object({ name: z.string(), url: z.string().nullish() }) });
export const syncSchema = z.object({
  added: z.array(transactionSchema),
  modified: z.array(transactionSchema),
  removed: z.array(z.object({ transaction_id: z.string() })),
  next_cursor: z.string(),
  has_more: z.boolean(),
});

export type PlaidTransaction = z.infer<typeof transactionSchema>;
export type PlaidAccount = z.infer<typeof accountSchema>;

export function parsePlaid<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'Plaid returned an invalid response');
  return parsed.data;
}

const cents = (amount: number) => Math.round(amount * 100);

export function toAccount(account: PlaidAccount) {
  const subtype = account.subtype ?? '';
  const kind: 'checking' | 'savings' | 'credit' | 'other' = account.type === 'credit' ? 'credit'
    : ['savings', 'money market', 'cd', 'hsa'].includes(subtype) ? 'savings'
    : account.type === 'depository' ? 'checking'
    : 'other';
  return {
    id: account.account_id,
    name: account.official_name ?? account.name,
    mask: account.mask ?? '',
    kind,
    balanceCents: cents(account.balances.current ?? account.balances.available ?? 0),
  };
}

/** The merchant's domain from Plaid's website field, for Logo.dev ("www.target.com" → "target.com"). */
export function domain(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const host = new URL(website.includes('://') ? website : `https://${website}`).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** "123 Main St, Lehi, UT 84043", only when Plaid has a street address (a city alone is too vague to pin). */
function streetAddress(location: PlaidTransaction['location']): string | null {
  const street = location?.address?.trim();
  if (!street) return null;
  const cityLine = [location?.city?.trim(), [location?.region?.trim(), location?.postal_code?.trim()].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  return [street, cityLine].filter(Boolean).join(', ');
}

export function toTransaction(transaction: PlaidTransaction) {
  return {
    id: transaction.transaction_id,
    accountId: transaction.account_id,
    date: transaction.authorized_date ?? transaction.date,
    payee: transaction.merchant_name ?? transaction.name,
    amountCents: Math.abs(cents(transaction.amount)),
    isIncome: transaction.amount < 0,
    category: transaction.personal_finance_category?.primary ?? null,
    categoryDetail: transaction.personal_finance_category?.detailed ?? null,
    logoUrl: transaction.logo_url ?? null,
    merchantDomain: domain(transaction.website),
    city: transaction.location?.city ?? null,
    address: streetAddress(transaction.location),
    latitude: transaction.location?.lat ?? null,
    longitude: transaction.location?.lon ?? null,
  };
}
