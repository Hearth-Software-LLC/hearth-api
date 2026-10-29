import { createHmac } from 'node:crypto';

/**
 * Reading a RevenueCat webhook event for affiliate credit, and the money math. Pure: the
 * database side is service.ts.
 *
 * Field names follow RevenueCat's webhook event (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields):
 * `price` is in US dollars (negative on a refund), `takehome_percentage` is the share left after
 * the store's commission and taxes, `offer_code` is the App Store offer code used, and
 * `subscriber_attributes` carries what the app saved to the customer (our `hearth_referral`).
 */

export type PurchaseEvent = {
  id: string;
  type: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  store: string;
  transactionId: string | null;
  originalTransactionId: string | null;
  productId: string;
  priceUsd: number;
  takehome: number;
  offerCode: string | null;
  referralCode: string | null;
  cancelReason: string | null;
  occurredAt: Date;
};

/** Events that are a paid (or free-trial) purchase or renewal. */
export const PURCHASE_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE']);
export const REFERRAL_ATTRIBUTE = 'hearth_referral';

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The event's purchase fields, or null when it isn't one affiliates care about. */
export function readPurchaseEvent(body: unknown): PurchaseEvent | null {
  if (!body || typeof body !== 'object') return null;
  const outer = body as Record<string, unknown>;
  const event = (outer.event && typeof outer.event === 'object' ? outer.event : outer) as Record<string, unknown>;
  const id = text(event.id) ?? text(event.event_id);
  const type = text(event.type)?.toUpperCase();
  if (!id || !type) return null;
  const refund = isRefund(type, text(event.cancel_reason));
  if (!PURCHASE_TYPES.has(type) && !refund) return null;
  const attributes = (event.subscriber_attributes && typeof event.subscriber_attributes === 'object'
    ? event.subscriber_attributes : {}) as Record<string, unknown>;
  const referral = attributes[REFERRAL_ATTRIBUTE] as { value?: unknown } | undefined;
  const at = number(event.purchased_at_ms) ?? number(event.event_timestamp_ms) ?? Date.now();
  const takehome = number(event.takehome_percentage);
  return {
    id,
    type,
    environment: text(event.environment)?.toUpperCase() === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION',
    store: (text(event.store) ?? 'APP_STORE').toUpperCase(),
    transactionId: text(event.transaction_id),
    originalTransactionId: text(event.original_transaction_id),
    productId: text(event.product_id) ?? 'unknown',
    priceUsd: number(event.price) ?? 0,
    // The App Store keeps 15–30%; without a figure, assume the standard 70% for safety.
    takehome: takehome !== null && takehome >= 0 && takehome <= 1 ? takehome : 0.7,
    offerCode: text(event.offer_code),
    referralCode: referral && typeof referral === 'object' ? text(referral.value) : null,
    cancelReason: text(event.cancel_reason)?.toUpperCase() ?? null,
    // A purchase counts when it was bought; a refund when it happened.
    occurredAt: new Date(refund ? number(event.event_timestamp_ms) ?? at : at),
  };
}

/** A refund reaches the webhook as a cancellation for customer support. */
export function isRefund(type: string, cancelReason: string | null) {
  return type === 'CANCELLATION' && (cancelReason ?? '').toUpperCase() === 'CUSTOMER_SUPPORT';
}

/** What the team receives for a purchase, in US cents (never negative here; refunds copy the credit). */
export function proceedsCents(priceUsd: number, takehome: number) {
  if (!(priceUsd > 0)) return 0;
  return Math.round(priceUsd * takehome * 100);
}

export type Terms = { rateBps: number | null; flatCents: number | null };

/**
 * The affiliate's share of one purchase, in cents. A rate is a share of proceeds, rounded half
 * up to the cent; a flat amount is paid once per subscription (on its first paid purchase).
 */
export function commissionCents(proceeds: number, terms: Terms, flatAlreadyPaid: boolean) {
  if (proceeds <= 0) return 0;
  if (terms.rateBps !== null) return Math.floor((proceeds * terms.rateBps + 5000) / 10000);
  if (terms.flatCents !== null) return flatAlreadyPaid ? 0 : terms.flatCents;
  return 0;
}

/** The code a subscriber used, kept the way codes are stored (upper case). */
export function normalizeCode(code: string | null) {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  return /^[A-Z0-9_-]{3,40}$/.test(upper) ? upper : null;
}

/** A keyed hash of a store transaction id: enough to match renewals and refunds, never to find a person. */
export function transactionKey(secret: Buffer, store: string, id: string) {
  return createHmac('sha256', secret).update(`affiliate-transaction:${store}:${id}`).digest('hex');
}

/** Adds whole months in UTC (the 31st into a short month lands on its last day). */
export function addMonths(date: Date, months: number) {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return result;
}

/** "2026-10" → the month's first instant and the next month's (UTC). */
export function monthRange(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error('A month looks like 2026-10');
  const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return { start, end: addMonths(start, 1) };
}

export const formatCents = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
