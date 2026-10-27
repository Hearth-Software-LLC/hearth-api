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
  /** Who the card belongs to, for accounts with several cards (sub-accounts). Bank-defined format, usually null. */
  account_owner: z.string().nullish(),
  /** The bank's raw text. Only read here for a card's last four digits; never sent to the apps. */
  original_description: z.string().nullish(),
  payment_channel: z.string().nullish(),
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

// MARK: Investments

const securitySchema = z.object({
  security_id: z.string().min(1),
  name: z.string().nullish(),
  ticker_symbol: z.string().nullish(),
  type: z.string().nullish(),
  is_cash_equivalent: z.boolean().nullish(),
  close_price: z.number().nullish(),
  close_price_as_of: z.string().nullish(),
});
const holdingSchema = z.object({
  account_id: z.string(),
  security_id: z.string(),
  quantity: z.number(),
  institution_price: z.number(),
  institution_price_as_of: z.string().nullish(),
  institution_value: z.number(),
  cost_basis: z.number().nullish(),
});
const investmentTransactionSchema = z.object({
  investment_transaction_id: z.string().min(1),
  account_id: z.string(),
  security_id: z.string().nullish(),
  date: z.string(),
  name: z.string(),
  quantity: z.number(),
  amount: z.number(),
  price: z.number(),
  fees: z.number().nullish(),
  type: z.string(),
  subtype: z.string().nullish(),
});

export const holdingsSchema = z.object({
  accounts: z.array(accountSchema),
  holdings: z.array(holdingSchema),
  securities: z.array(securitySchema),
});
export const investmentTransactionsSchema = z.object({
  accounts: z.array(accountSchema),
  investment_transactions: z.array(investmentTransactionSchema),
  securities: z.array(securitySchema),
  total_investment_transactions: z.number().int(),
});

/** Plaid's investment subtypes, reduced to the handful the app names ("401(k)", "IRA"…). */
export function toInvestmentAccount(account: PlaidAccount) {
  const subtype = (account.subtype ?? '').toLowerCase();
  const kind: '401k' | 'ira' | 'roth' | 'brokerage' | 'education' | 'hsa' | 'other' =
    ['401k', '403b', '457b', 'thrift savings plan', 'pension', 'retirement', 'keogh', 'profit sharing plan'].includes(subtype) ? '401k'
    : ['roth', 'roth 401k'].includes(subtype) ? 'roth'
    : ['ira', 'sep ira', 'simple ira', 'sarsep', 'rollover'].includes(subtype) ? 'ira'
    : ['529', 'education savings account'].includes(subtype) ? 'education'
    : subtype === 'hsa' ? 'hsa'
    : ['brokerage', 'non-taxable brokerage account', 'stock plan', 'mutual fund', 'trust', 'ugma', 'utma'].includes(subtype) ? 'brokerage'
    : 'other';
  return {
    id: account.account_id,
    name: account.official_name ?? account.name,
    mask: account.mask ?? '',
    kind,
    balanceCents: cents(account.balances.current ?? account.balances.available ?? 0),
  };
}

export function toSecurity(security: z.infer<typeof securitySchema>) {
  return {
    id: security.security_id,
    ticker: security.ticker_symbol ?? null,
    name: security.name ?? security.ticker_symbol ?? 'Security',
    type: security.type ?? 'other',
    isCash: security.is_cash_equivalent ?? false,
    closePrice: security.close_price ?? null,
    closePriceDate: security.close_price_as_of ?? null,
  };
}

export function toHolding(holding: z.infer<typeof holdingSchema>) {
  return {
    accountId: holding.account_id,
    securityId: holding.security_id,
    quantity: holding.quantity,
    price: holding.institution_price,
    priceDate: holding.institution_price_as_of ?? null,
    valueCents: cents(holding.institution_value),
    costBasisCents: holding.cost_basis == null ? null : cents(holding.cost_basis),
  };
}

/** Plaid: a positive amount is cash leaving the account (a buy); `cashIn` says which way it went. */
export function toInvestmentTransaction(transaction: z.infer<typeof investmentTransactionSchema>) {
  return {
    id: transaction.investment_transaction_id,
    accountId: transaction.account_id,
    securityId: transaction.security_id ?? null,
    date: transaction.date,
    name: transaction.name,
    kind: transaction.type,
    subtype: transaction.subtype ?? null,
    quantity: transaction.quantity,
    price: transaction.price,
    amountCents: Math.abs(cents(transaction.amount)),
    cashIn: transaction.amount < 0,
    feesCents: transaction.fees == null ? 0 : cents(transaction.fees),
  };
}

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
    ...cardOf(transaction),
    paymentChannel: transaction.payment_channel ?? null,
  };
}

/**
 * Which card a charge was made with, so Suffice can tell whose it was on an account with more
 * than one card. Plaid's `account_owner` comes first (a name, a last four, or both, in whatever
 * format the bank uses); otherwise the last four digits from the bank's raw description
 * ("POS DEBIT … CARD 5678", "XXXXXXXXXXXX5678"). Only the last four and the owner label leave the
 * API, never the raw description.
 */
export function cardOf(transaction: Pick<PlaidTransaction, 'account_owner' | 'original_description'>): {
  cardLabel: string | null; cardLast4: string | null;
} {
  const owner = transaction.account_owner?.replace(/\s+/g, ' ').trim() || null;
  const cardLabel = owner ? owner.slice(0, 64) : null;
  const fromOwner = owner?.match(/(?:^|\D)(\d{4})\s*$/)?.[1] ?? null;
  return { cardLabel, cardLast4: fromOwner ?? lastFourInDescription(transaction.original_description) };
}

/** A card's last four in a bank description, or null. Store numbers ("#1820") don't count. */
export function lastFourInDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const patterns = [
    /\b(?:CARD|CRD)\s*(?:NO\.?|#|ENDING(?:\s+IN)?)?\s*[X*]*\s*(\d{4})\b/i,
    /[X*]{4,}[\s-]*(\d{4})\b/i,
  ];
  for (const pattern of patterns) {
    const found = description.match(pattern)?.[1];
    if (found) return found;
  }
  return null;
}
