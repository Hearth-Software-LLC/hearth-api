import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { parseCampaignReport } from '../../src/affiliates/asc.js';
import { addMonths, commissionCents, monthRange, proceedsCents, readPurchaseEvent } from '../../src/affiliates/credit.js';
import { creditAffiliateEvent } from '../../src/affiliates/hook.js';
import { createLinkService } from '../../src/affiliates/links.js';
import { createAffiliateService } from '../../src/affiliates/service.js';
import type { AffiliateService } from '../../src/affiliates/service.js';
import { createTeamService } from '../../src/studio/team.js';
import { migrate, reset } from './database.js';

describe('affiliate money math', () => {
  it('works out proceeds and commission to the cent', () => {
    expect(proceedsCents(39.99, 0.85)).toBe(3399);
    expect(proceedsCents(-39.99, 0.85)).toBe(0);
    expect(proceedsCents(0, 0.85)).toBe(0);
    // 20% of $33.99 is $6.798: half up to the cent is $6.80.
    expect(commissionCents(3399, { rateBps: 2000, flatCents: null }, false)).toBe(680);
    // 15% of $0.25 is 3.75 cents → 4.
    expect(commissionCents(25, { rateBps: 1500, flatCents: null }, false)).toBe(4);
    expect(commissionCents(3399, { rateBps: null, flatCents: 500 }, false)).toBe(500);
    expect(commissionCents(3399, { rateBps: null, flatCents: 500 }, true)).toBe(0);
  });

  it('adds months without running into the next one', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonths(new Date('2026-10-15T00:00:00Z'), 12).toISOString()).toBe('2027-10-15T00:00:00.000Z');
    expect(monthRange('2026-12')).toEqual({ start: new Date('2026-12-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z') });
  });

  it('reads purchases and refunds from RevenueCat events', () => {
    const purchase = readPurchaseEvent({ event: {
      id: 'e1', type: 'INITIAL_PURCHASE', environment: 'PRODUCTION', store: 'APP_STORE', product_id: 'sated_plus_annual',
      price: 39.99, takehome_percentage: 0.85, offer_code: 'kristen20', original_transaction_id: '1000', transaction_id: '1000', purchased_at_ms: 1_780_000_000_000,
    } })!;
    expect(purchase).toMatchObject({ type: 'INITIAL_PURCHASE', offerCode: 'kristen20', priceUsd: 39.99, takehome: 0.85 });
    expect(readPurchaseEvent({ event: { id: 'e2', type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' } })).toBeNull();
    expect(readPurchaseEvent({ event: { id: 'e3', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', event_timestamp_ms: 5 } })!.occurredAt.getTime()).toBe(5);
    expect(readPurchaseEvent({ event: { id: 'e4', type: 'BILLING_ISSUE' } })).toBeNull();
  });

  it('reads App Store Connect campaign reports by header', () => {
    const downloads = 'Date\tApp Name\tDownload Type\tCampaign\tCounts\n2026-10-20\tSated\tFirst-time download\tkristen-ig\t5\n'
      + '2026-10-20\tSated\tRedownload\tkristen-ig\t2\n2026-10-20\tSated\tFirst-time download\tkristen-ig\t3\n2026-10-20\tSated\tFirst-time download\t\t40\n';
    expect(parseCampaignReport(downloads)).toEqual([
      { ct: 'kristen-ig', day: '2026-10-20', metric: 'downloads', value: 8 },
      { ct: 'kristen-ig', day: '2026-10-20', metric: 'redownloads', value: 2 },
    ]);
    const engagement = 'Date\tEvent\tCampaign\tCounts\n2026-10-21\tPage view\tkristen-ig\t31\n2026-10-21\tImpression\tkristen-ig\t400\n';
    expect(parseCampaignReport(engagement)).toEqual([{ ct: 'kristen-ig', day: '2026-10-21', metric: 'page_views', value: 31 }]);
  });
});

// Against a real Postgres: set SOCIAL_TEST_DATABASE_URL (or HEARKEN_TEST_DATABASE_URL) to an empty scratch database.
const url = process.env.SOCIAL_TEST_DATABASE_URL ?? process.env.HEARKEN_TEST_DATABASE_URL;

const steve = '00000000-0000-4000-8000-0000000000aa';
const kristen = '00000000-0000-4000-8000-0000000000cc';
const helper = '00000000-0000-4000-8000-0000000000ee';
const stranger = '00000000-0000-4000-8000-0000000000bb';
const users: Record<string, string> = { steve, kristen, helper, stranger };
const day = 86_400_000;

let serial = 0;
function event(fields: Record<string, unknown>) {
  serial += 1;
  return { api_version: '1.0', event: {
    id: `evt-${serial}`, environment: 'PRODUCTION', store: 'APP_STORE', product_id: 'sated_plus_annual', takehome_percentage: 0.85,
    app_user_id: 'someone', ...fields,
  } };
}

describe.skipIf(!url)('affiliates (Postgres)', () => {
  let sql: postgres.Sql;
  let release: (() => Promise<void>) | undefined;
  let app: ReturnType<typeof createApp>;
  let service: AffiliateService;
  let teamId: string;

  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => undefined });
    release = await migrate(sql);
    teamId = String((await sql`select id from studio_teams where slug = 'hearth'`)[0]!.id);
  });
  afterAll(async () => { await release?.(); await sql?.end(); });

  beforeEach(async () => {
    await reset(sql);
    service = createAffiliateService(sql, { secret: Buffer.alloc(32, 3) });
    app = createApp({
      config: readConfig({ SOCIAL_OWNER_IDS: steve, SOCIAL_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), ASC_PROVIDER_ID: '118000' }),
      verifyToken: async (bearer) => ({ userId: users[bearer] ?? stranger, isAnonymous: bearer === 'anonymous' }),
      reserveQuota: async () => undefined,
      entitlements: async () => [],
      studio: { team: createTeamService(sql, { ownerIds: [steve] }), sql },
      affiliates: { service, links: createLinkService(sql, { providerId: '118000', shortBase: 'https://hearthapps.com/go' }) },
    });
  });

  const call = async (who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(path, {
      method,
      headers: { Authorization: `Bearer ${who}`, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const json = response.headers.get('content-type')?.includes('json');
    return { status: response.status, body: text && json ? JSON.parse(text) : text, headers: response.headers };
  };

  async function kristenOnSated(terms: Record<string, unknown> = { rateBps: 2000 }) {
    await call('steve', 'GET', '/v1/studio/me');
    const created = await call('steve', 'POST', '/v1/studio/affiliates', { name: 'Kristen', contact: 'kristen@example.com', ...terms });
    expect(created.status).toBe(200);
    const id = String(created.body.id);
    expect((await call('steve', 'POST', `/v1/studio/affiliates/${id}/codes`, { app: 'sated', code: 'kristen20', kind: 'apple_offer' })).status).toBe(200);
    return id;
  }

  it('credits coded purchases exactly once, renewals in the window, and claws back refunds', async () => {
    const id = await kristenOnSated();
    const bought = Date.now() - 20 * day;
    const first = event({ type: 'INITIAL_PURCHASE', price: 39.99, offer_code: 'KRISTEN20', original_transaction_id: '2000', transaction_id: '2000', purchased_at_ms: bought });
    expect(await creditAffiliateEvent(first)).toEqual({ outcome: 'credited', affiliateId: id, commissionCents: 680 });
    // RevenueCat retries: nothing new.
    expect(await creditAffiliateEvent(first)).toEqual({ outcome: 'duplicate' });

    // A renewal carries no code; the subscription remembers.
    const renewal = event({ type: 'RENEWAL', price: 39.99, original_transaction_id: '2000', transaction_id: '2001', purchased_at_ms: bought + 10 * day });
    expect(await creditAffiliateEvent(renewal)).toMatchObject({ outcome: 'credited', commissionCents: 680 });
    // After the 12-month window: no credit.
    const late = event({ type: 'RENEWAL', price: 39.99, original_transaction_id: '2000', transaction_id: '2002', purchased_at_ms: bought + 400 * day });
    expect(await creditAffiliateEvent(late)).toMatchObject({ outcome: 'ignored', reason: 'outside the credit window' });

    // Not hers, sandbox, and a code nobody has.
    expect(await creditAffiliateEvent(event({ type: 'INITIAL_PURCHASE', price: 39.99, original_transaction_id: '3000', transaction_id: '3000', purchased_at_ms: bought })))
      .toMatchObject({ outcome: 'ignored', reason: 'no code' });
    expect(await creditAffiliateEvent(event({ type: 'INITIAL_PURCHASE', environment: 'SANDBOX', price: 39.99, offer_code: 'KRISTEN20', original_transaction_id: '4000', purchased_at_ms: bought })))
      .toMatchObject({ outcome: 'ignored', reason: 'sandbox' });
    expect(await creditAffiliateEvent(event({ type: 'INITIAL_PURCHASE', price: 39.99, offer_code: 'NOPE99', original_transaction_id: '5000', purchased_at_ms: bought })))
      .toEqual({ outcome: 'unknown_code', code: 'NOPE99' });

    // A refund of the renewal takes its commission back.
    const refund = event({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', price: -39.99, original_transaction_id: '2000', transaction_id: '2001',
      purchased_at_ms: bought + 10 * day, event_timestamp_ms: Date.now() - day });
    expect(await creditAffiliateEvent(refund)).toMatchObject({ outcome: 'refunded', commissionCents: -680 });
    expect(await creditAffiliateEvent({ event: { ...refund.event, id: 'evt-refund-again' } })).toEqual({ outcome: 'duplicate' });

    const detail = await call('steve', 'GET', `/v1/studio/affiliates/${id}`);
    expect(detail.body.affiliate.owedCents).toBe(680);
    expect(detail.body.credits.map((entry: { kind: string; commissionCents: number }) => [entry.kind, entry.commissionCents]))
      .toEqual([['refund', -680], ['renewal', 680], ['purchase', 680]]);
    // No transaction ids or people anywhere in what's stored.
    const stored = await sql`select * from affiliate_credits`;
    expect(JSON.stringify(stored)).not.toMatch(/"2000"|"2001"|someone/);
  });

  it('pays a flat amount once per subscriber, and a free trial only starts the attribution', async () => {
    const id = await kristenOnSated({ flatCents: 500 });
    const start = Date.now() - 30 * day;
    expect(await creditAffiliateEvent(event({ type: 'INITIAL_PURCHASE', price: 0, offer_code: 'KRISTEN20', original_transaction_id: '6000', transaction_id: '6000', purchased_at_ms: start })))
      .toEqual({ outcome: 'attributed', affiliateId: id });
    expect(await creditAffiliateEvent(event({ type: 'RENEWAL', price: 39.99, original_transaction_id: '6000', transaction_id: '6001', purchased_at_ms: start + 7 * day })))
      .toMatchObject({ outcome: 'credited', commissionCents: 500 });
    expect(await creditAffiliateEvent(event({ type: 'RENEWAL', price: 39.99, original_transaction_id: '6000', transaction_id: '6002', purchased_at_ms: start + 20 * day })))
      .toMatchObject({ outcome: 'credited', commissionCents: 0 });
  });

  it('records payouts, refuses paying nothing or with open flags, and carries a later refund over', async () => {
    const id = await kristenOnSated();
    const bought = Date.now() - 20 * day;
    await creditAffiliateEvent(event({ type: 'INITIAL_PURCHASE', price: 39.99, offer_code: 'KRISTEN20', original_transaction_id: '7000', transaction_id: '7000', purchased_at_ms: bought }));
    await creditAffiliateEvent(event({ type: 'INITIAL_PURCHASE', price: 9.99, offer_code: 'KRISTEN20', original_transaction_id: '7100', transaction_id: '7100', purchased_at_ms: bought }));
    const today = new Date().toISOString().slice(0, 10);

    // A refund matching nothing credited is flagged, and blocks paying.
    await creditAffiliateEvent(event({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', price: -9.99, original_transaction_id: '7100', transaction_id: '7199', event_timestamp_ms: Date.now() }));
    const blocked = await call('steve', 'POST', `/v1/studio/affiliates/${id}/payouts`, { through: today });
    expect(blocked.body.error.code).toBe('FLAGS_OPEN');
    const flags = await call('steve', 'GET', '/v1/studio/affiliate-flags');
    expect(flags.body.flags).toHaveLength(1);
    await call('steve', 'POST', `/v1/studio/affiliate-flags/${flags.body.flags[0].id}/resolve`);

    const paid = await call('steve', 'POST', `/v1/studio/affiliates/${id}/payouts`, { through: today, note: 'PayPal' });
    // $6.80 + 20% of $8.49 ($1.698 → $1.70).
    expect(paid.body).toMatchObject({ totalCents: 850, credits: 2 });
    expect((await call('steve', 'POST', `/v1/studio/affiliates/${id}/payouts`, { through: today })).body.error.code).toBe('NOTHING_OWED');

    // Refunded after being paid: owed goes negative and comes off the next payout.
    await creditAffiliateEvent(event({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', price: -39.99, original_transaction_id: '7000', transaction_id: '7000', event_timestamp_ms: Date.now() }));
    expect((await call('steve', 'GET', `/v1/studio/affiliates/${id}`)).body.affiliate.owedCents).toBe(-680);

    // Undoing the payout makes its credits owed again (owners only).
    const statement = await call('steve', 'GET', `/v1/studio/affiliates/${id}/statement?month=${today.slice(0, 7)}`);
    expect(statement.headers.get('content-type')).toContain('text/csv');
    expect(String(statement.body).split('\n')[0]).toBe('Date,App,Plan,Kind,Proceeds (USD),Your share (USD),Paid');
    expect(String(statement.body).trim().split('\n').at(-1)).toMatch(/^Total,,,,,-?\d+\.\d{2},$/);
    expect((await call('steve', 'DELETE', `/v1/studio/affiliate-payouts/${paid.body.id}`)).status).toBe(200);
    expect((await call('steve', 'GET', `/v1/studio/affiliates/${id}`)).body.affiliate.owedCents).toBe(170);
  });

  it('reconciles a month from stored webhook events, adding what a failed webhook missed', async () => {
    const id = await kristenOnSated();
    const month = new Date().toISOString().slice(0, 7);
    const missed = event({ type: 'INITIAL_PURCHASE', price: 39.99, offer_code: 'KRISTEN20', original_transaction_id: '8000', transaction_id: '8000', purchased_at_ms: monthRange(month).start.getTime() + 1000 });
    const stray = event({ type: 'INITIAL_PURCHASE', price: 39.99, offer_code: 'TYPO20', original_transaction_id: '8100', purchased_at_ms: monthRange(month).start.getTime() + 2000 });
    const result = await service.reconcile(teamId, month, async () => [missed, stray]);
    expect(result).toMatchObject({ checked: 2, added: 1, unknownCodes: 1, openFlags: 1 });
    expect(await service.reconcile(teamId, month, async () => [missed, stray])).toMatchObject({ added: 0, openFlags: 1 });
    expect((await service.get(teamId, id)).owedCents).toBe(680);
  });

  it('keeps money from members without the permission, and gives affiliates only their own', async () => {
    const id = await kristenOnSated();
    await creditAffiliateEvent(event({ type: 'INITIAL_PURCHASE', price: 39.99, offer_code: 'KRISTEN20', original_transaction_id: '9000', transaction_id: '9000', purchased_at_ms: Date.now() - day }));

    // A team member who may post but not see affiliate money.
    const teamInvite = await call('steve', 'POST', '/v1/studio/invites', { post: true });
    await call('helper', 'POST', `/v1/studio/invites/${teamInvite.body.code}/join`, {});
    const seen = await call('helper', 'GET', '/v1/studio/affiliates');
    expect(seen.body.affiliates[0]).toMatchObject({ name: 'Kristen' });
    expect(seen.body.affiliates[0].owedCents).toBeUndefined();
    expect(seen.body.affiliates[0].contact).toBeUndefined();
    expect((await call('helper', 'POST', `/v1/studio/affiliates/${id}/payouts`, { through: '2026-12-31' })).body.error.code).toBe('PERMISSION_REQUIRED');

    // Kristen joins as an affiliate.
    expect((await call('kristen', 'GET', '/v1/affiliate/me')).body.error.code).toBe('NOT_AN_AFFILIATE');
    const invite = await call('steve', 'POST', `/v1/studio/affiliates/${id}/invite`);
    expect(invite.body.code).toMatch(/^[A-Z2-9]{8}$/);
    expect((await call('anonymous', 'POST', `/v1/affiliate/invites/${invite.body.code}/join`)).body.error.code).toBe('REGISTERED_IDENTITY_REQUIRED');
    expect((await call('kristen', 'POST', `/v1/affiliate/invites/${invite.body.code}/join`)).status).toBe(200);
    expect((await call('stranger', 'POST', `/v1/affiliate/invites/${invite.body.code}/join`)).body.error.code).toBe('INVITE_NOT_FOUND');

    const me = await call('kristen', 'GET', '/v1/affiliate/me');
    expect(me.body.affiliate).toMatchObject({ name: 'Kristen', owedCents: 680, joined: true });
    expect(me.body.affiliate.contact).toBeUndefined();
    expect(me.body.codes.map((entry: { code: string }) => entry.code)).toEqual(['KRISTEN20']);
    expect(me.body.credits).toHaveLength(1);
    // The team's side stays closed to her.
    expect((await call('kristen', 'GET', '/v1/studio/affiliates')).body.error.code).toBe('NOT_ON_TEAM');
    expect((await call('kristen', 'GET', `/v1/affiliate/me/statement?month=${new Date().toISOString().slice(0, 7)}`)).status).toBe(200);

    // Access can be ended.
    await call('steve', 'DELETE', `/v1/studio/affiliates/${id}/access`);
    expect((await call('kristen', 'GET', '/v1/affiliate/me')).body.error.code).toBe('NOT_AN_AFFILIATE');
  });

  it('makes campaign links, follows short links and counts taps (not crawlers)', async () => {
    const id = await kristenOnSated();
    const made = await call('steve', 'POST', '/v1/studio/links', { app: 'sated', name: 'Kristen IG', appStoreId: '1234567890', affiliateId: id });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ ct: 'kristen-ig', slug: 'sated-kristen-ig', shortUrl: 'https://hearthapps.com/go/sated-kristen-ig',
      url: 'https://apps.apple.com/app/id1234567890?pt=118000&ct=kristen-ig&mt=8' });
    expect((await call('steve', 'POST', '/v1/studio/links', { app: 'sated', name: 'Kristen IG', appStoreId: '1234567890' })).body.error.code).toBe('LINK_TAKEN');

    const phone = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' };
    const tap = await app.request('/go/sated-kristen-ig', { headers: phone });
    expect(tap.status).toBe(302);
    expect(tap.headers.get('location')).toBe(made.body.url);
    await app.request('/go/sated-kristen-ig', { headers: phone });
    await app.request('/go/sated-kristen-ig', { headers: { 'user-agent': 'facebookexternalhit/1.1' } });
    expect((await app.request('/go/nothing-here')).status).toBe(404);

    const today = new Date().toISOString().slice(0, 10);
    await createLinkService(sql, { shortBase: 'https://x' }).recordStats(teamId, 'sated', [{ ct: 'kristen-ig', day: today, metric: 'downloads', value: 4 }]);
    const list = await call('steve', 'GET', '/v1/studio/links?app=sated');
    expect(list.body.links[0].totals).toMatchObject({ taps: 2, downloads: 4 });
    const campaigns = await call('steve', 'GET', '/v1/studio/appstore/sated/campaigns');
    expect(campaigns.body).toMatchObject({ updatedThrough: today, totals: { downloads: 4 }, campaigns: [{ ct: 'kristen-ig', name: 'Kristen IG' }] });
    // Her links show on her own page too.
    const invite = await call('steve', 'POST', `/v1/studio/affiliates/${id}/invite`);
    await call('kristen', 'POST', `/v1/affiliate/invites/${invite.body.code}/join`);
    expect((await call('kristen', 'GET', '/v1/affiliate/me')).body.links[0]).toMatchObject({ name: 'Kristen IG', totals: { taps: 2 } });

    await call('steve', 'DELETE', `/v1/studio/links/${made.body.id}`);
    expect((await app.request('/go/sated-kristen-ig', { headers: phone })).status).toBe(404);
  });
});
