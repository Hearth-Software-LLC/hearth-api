import type { AffiliateService } from './service.js';

/**
 * The RevenueCat webhook (a plain BigTable handler without the app's dependencies) credits
 * affiliates through here; createApp sets it. Crediting is idempotent per event, so a webhook
 * that fails after this and is retried credits nothing twice.
 */
let service: AffiliateService | undefined;

export function setAffiliateCredit(next: AffiliateService | undefined) {
  service = next;
}

/** Credits the event when it carries an affiliate's code. Throws so RevenueCat retries a failure. */
export async function creditAffiliateEvent(body: unknown) {
  if (!service) return undefined;
  return service.creditEvent(body);
}
