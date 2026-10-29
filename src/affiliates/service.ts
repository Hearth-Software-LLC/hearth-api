import type { Sql } from 'postgres';
import { ApiError } from '../errors.js';
import { isUniqueViolation, newInviteCode } from '../hearken/service.js';
import {
  addMonths, commissionCents, formatCents, isRefund, monthRange, normalizeCode, proceedsCents, readPurchaseEvent, transactionKey,
} from './credit.js';
import type { PurchaseEvent } from './credit.js';

/**
 * Affiliates: their terms and codes, the exact credit RevenueCat purchases earn them, payouts,
 * statements, and their own sign-in. See supabase/migrations/20261029200000_affiliates_and_links.sql.
 */

export type AffiliateTerms = { rateBps: number | null; flatCents: number | null; windowMonths: number };

export type AffiliateView = {
  id: string;
  name: string;
  contact: string | null;
  terms: AffiliateTerms;
  active: boolean;
  /** Has signed in to see their own sales. */
  joined: boolean;
  /** Unpaid commission. */
  owedCents: number;
  /** Commission and paid sales this calendar month (UTC). */
  monthCents: number;
  monthSales: number;
  apps: string[];
  createdAt: string;
};

export type CodeView = { id: string; affiliateId: string; app: string; code: string; kind: 'apple_offer' | 'referral'; offerRef: string | null; active: boolean; createdAt: string };

export type CreditView = {
  id: string; affiliateId: string; app: string; product: string; kind: 'purchase' | 'renewal' | 'refund' | 'adjustment';
  proceedsCents: number; commissionCents: number; occurredAt: string; paid: boolean; note: string | null;
};

export type PayoutView = { id: string; affiliateId: string; through: string; totalCents: number; note: string | null; paidAt: string; credits: number };

export type FlagView = { id: string; affiliateId: string | null; kind: string; detail: string; createdAt: string };

export type CreditOutcome =
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'duplicate' }
  | { outcome: 'attributed'; affiliateId: string }
  | { outcome: 'credited'; affiliateId: string; commissionCents: number }
  | { outcome: 'refunded'; affiliateId: string; commissionCents: number }
  | { outcome: 'unknown_code'; code: string };

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
const day = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
const int = (value: unknown) => Number(value ?? 0);

function code(row: Record<string, unknown>): CodeView {
  return {
    id: String(row.id), affiliateId: String(row.affiliate_id), app: String(row.app), code: String(row.code),
    kind: row.kind as CodeView['kind'], offerRef: (row.offer_ref as string | null) ?? null, active: row.active === true, createdAt: iso(row.created_at),
  };
}

function credit(row: Record<string, unknown>): CreditView {
  return {
    id: String(row.id), affiliateId: String(row.affiliate_id), app: String(row.app), product: String(row.product), kind: row.kind as CreditView['kind'],
    proceedsCents: int(row.proceeds_cents), commissionCents: int(row.commission_cents), occurredAt: iso(row.occurred_at),
    paid: row.payout_id != null, note: (row.note as string | null) ?? null,
  };
}

function payout(row: Record<string, unknown>): PayoutView {
  return {
    id: String(row.id), affiliateId: String(row.affiliate_id), through: day(row.through), totalCents: int(row.total_cents),
    note: (row.note as string | null) ?? null, paidAt: iso(row.paid_at), credits: int(row.credits),
  };
}

export type AffiliateService = ReturnType<typeof createAffiliateService>;

export function createAffiliateService(sql: Sql, options: { secret: Buffer; acceptSandbox?: boolean; now?: () => number }) {
  const now = options.now ?? Date.now;
  const thisMonth = () => new Date(now()).toISOString().slice(0, 7);

  /** Affiliates with their money summed (one query for a list or one). */
  async function views(team: string, id?: string): Promise<AffiliateView[]> {
    const { start, end } = monthRange(thisMonth());
    const rows = await sql`
      select a.*,
        coalesce((select sum(c.commission_cents) from affiliate_credits c where c.affiliate_id = a.id and c.payout_id is null), 0) as owed,
        coalesce((select sum(c.commission_cents) from affiliate_credits c where c.affiliate_id = a.id
          and c.occurred_at >= ${start} and c.occurred_at < ${end}), 0) as month_cents,
        (select count(*) from affiliate_credits c where c.affiliate_id = a.id and c.kind in ('purchase', 'renewal')
          and c.occurred_at >= ${start} and c.occurred_at < ${end}) as month_sales,
        coalesce((select array_agg(distinct k.app order by k.app) from affiliate_codes k where k.affiliate_id = a.id), '{}') as apps
      from affiliates a
      where a.team_id = ${team} and (${id ?? null}::uuid is null or a.id = ${id ?? null})
      order by a.active desc, a.name`;
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), contact: (row.contact as string | null) ?? null,
      terms: { rateBps: row.rate_bps == null ? null : int(row.rate_bps), flatCents: row.flat_cents == null ? null : int(row.flat_cents), windowMonths: int(row.window_months) },
      active: row.active === true, joined: row.user_id != null,
      owedCents: int(row.owed), monthCents: int(row.month_cents), monthSales: int(row.month_sales),
      apps: (row.apps as string[]) ?? [], createdAt: iso(row.created_at),
    }));
  }

  async function one(team: string, id: string) {
    const [found] = await views(team, id);
    if (!found) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Affiliate not found');
    return found;
  }

  function checkTerms(terms: { rateBps?: number | null | undefined; flatCents?: number | null | undefined }) {
    const rate = terms.rateBps ?? null, flat = terms.flatCents ?? null;
    if ((rate === null) === (flat === null)) throw new ApiError(400, 'INVALID_REQUEST', 'Give either a percentage or a flat amount');
    return { rate, flat };
  }

  async function codeFor(value: string | null): Promise<(CodeView & { teamId: string }) | undefined> {
    if (!value) return undefined;
    const upper = normalizeCode(value);
    const [row] = await sql`
      select k.*, k.team_id as team from affiliate_codes k join affiliates a on a.id = k.affiliate_id
      where k.active and a.active and (k.code = ${upper ?? ''} or k.offer_ref = ${value.trim()})
      limit 1`;
    return row ? { ...code(row), teamId: String(row.team) } : undefined;
  }

  // MARK: Credit

  /** One RevenueCat webhook event: starts an attribution, credits a purchase, or claws back a refund. Idempotent. */
  async function creditEvent(body: unknown): Promise<CreditOutcome> {
    const event = readPurchaseEvent(body);
    if (!event) return { outcome: 'ignored', reason: 'not a purchase or refund' };
    if (event.environment === 'SANDBOX' && !options.acceptSandbox) return { outcome: 'ignored', reason: 'sandbox' };
    const [seen] = await sql`select 1 from affiliate_credits where event_id = ${event.id}`;
    if (seen) return { outcome: 'duplicate' };
    if (!event.originalTransactionId) return { outcome: 'ignored', reason: 'no transaction id' };
    const subscriptionKey = transactionKey(options.secret, event.store, event.originalTransactionId);
    const purchaseKey = event.transactionId ? transactionKey(options.secret, event.store, event.transactionId) : null;
    if (isRefund(event.type, event.cancelReason)) return refund(event, subscriptionKey, purchaseKey);
    return purchase(event, subscriptionKey, purchaseKey);
  }

  async function purchase(event: PurchaseEvent, subscriptionKey: string, purchaseKey: string | null): Promise<CreditOutcome> {
    const used = normalizeCode(event.offerCode) ?? normalizeCode(event.referralCode);
    const matched = await codeFor(event.offerCode) ?? await codeFor(event.referralCode);
    return sql.begin(async (tx) => {
      let [attribution] = await tx`select * from affiliate_attributions where subscription_key = ${subscriptionKey} for update`;
      if (!attribution) {
        if (!matched) return used ? { outcome: 'unknown_code', code: used } as const : { outcome: 'ignored', reason: 'no code' } as const;
        const [affiliate] = await tx`select window_months from affiliates where id = ${matched.affiliateId}`;
        const ends = addMonths(event.occurredAt, int(affiliate!.window_months));
        [attribution] = await tx`
          insert into affiliate_attributions (team_id, affiliate_id, code_id, app, subscription_key, started_at, ends_at)
          values (${matched.teamId}, ${matched.affiliateId}, ${matched.id}, ${matched.app}, ${subscriptionKey}, ${event.occurredAt}, ${ends})
          on conflict (team_id, subscription_key) do nothing
          returning *`;
        if (!attribution) [attribution] = await tx`select * from affiliate_attributions where subscription_key = ${subscriptionKey} for update`;
      }
      const affiliateId = String(attribution!.affiliate_id);
      if (event.occurredAt < (attribution!.started_at as Date) || event.occurredAt >= (attribution!.ends_at as Date)) {
        return { outcome: 'ignored', reason: 'outside the credit window' } as const;
      }
      const proceeds = proceedsCents(event.priceUsd, event.takehome);
      if (proceeds <= 0) return { outcome: 'attributed', affiliateId } as const;
      const [terms] = await tx`select rate_bps, flat_cents from affiliates where id = ${affiliateId}`;
      const commission = commissionCents(proceeds, {
        rateBps: terms!.rate_bps == null ? null : int(terms!.rate_bps),
        flatCents: terms!.flat_cents == null ? null : int(terms!.flat_cents),
      }, attribution!.flat_paid === true);
      const [made] = await tx`
        insert into affiliate_credits (team_id, affiliate_id, attribution_id, event_id, transaction_key, app, product, kind,
          proceeds_cents, commission_cents, occurred_at)
        values (${attribution!.team_id}, ${affiliateId}, ${attribution!.id}, ${event.id}, ${purchaseKey}, ${attribution!.app},
          ${event.productId.slice(0, 200)}, ${event.type === 'RENEWAL' ? 'renewal' : 'purchase'}, ${proceeds}, ${commission}, ${event.occurredAt})
        on conflict (event_id) do nothing
        returning id`;
      if (!made) return { outcome: 'duplicate' } as const;
      if (terms!.flat_cents != null && commission > 0) {
        await tx`update affiliate_attributions set flat_paid = true where id = ${attribution!.id}`;
      }
      return { outcome: 'credited', affiliateId, commissionCents: commission } as const;
    }) as Promise<CreditOutcome>;
  }

  async function refund(event: PurchaseEvent, subscriptionKey: string, purchaseKey: string | null): Promise<CreditOutcome> {
    return sql.begin(async (tx) => {
      const [attribution] = await tx`select * from affiliate_attributions where subscription_key = ${subscriptionKey} for update`;
      if (!attribution) return { outcome: 'ignored', reason: 'not an affiliate subscription' } as const;
      const affiliateId = String(attribution.affiliate_id);
      const [original] = purchaseKey
        ? await tx`select * from affiliate_credits where transaction_key = ${purchaseKey} and kind in ('purchase', 'renewal') limit 1`
        : [];
      if (!original) {
        // A refunded free trial earned nothing; anything else needs a look before the next payout.
        if (event.priceUsd < 0) {
          await tx`
            insert into affiliate_flags (team_id, affiliate_id, kind, detail, event_id)
            values (${attribution.team_id}, ${affiliateId}, 'refund_without_purchase',
              ${`A refund of ${formatCents(Math.round(event.priceUsd * 100))} for ${event.productId} matched no credited purchase.`}, ${event.id})
            on conflict do nothing`;
        }
        return { outcome: 'ignored', reason: 'no credited purchase to refund' } as const;
      }
      const [already] = await tx`select 1 from affiliate_credits where transaction_key = ${purchaseKey} and kind = 'refund'`;
      if (already) return { outcome: 'duplicate' } as const;
      const commission = -int(original.commission_cents);
      const [made] = await tx`
        insert into affiliate_credits (team_id, affiliate_id, attribution_id, event_id, transaction_key, app, product, kind,
          proceeds_cents, commission_cents, occurred_at, note)
        values (${attribution.team_id}, ${affiliateId}, ${attribution.id}, ${event.id}, ${purchaseKey}, ${original.app},
          ${original.product}, 'refund', ${-int(original.proceeds_cents)}, ${commission}, ${event.occurredAt},
          ${original.payout_id ? 'Refund of a purchase already paid out: taken off the next payout' : null})
        on conflict (event_id) do nothing
        returning id`;
      if (!made) return { outcome: 'duplicate' } as const;
      return { outcome: 'refunded', affiliateId, commissionCents: commission } as const;
    }) as Promise<CreditOutcome>;
  }

  return {
    creditEvent,
    list: (team: string) => views(team),
    get: one,

    async create(team: string, input: { name: string; contact?: string | null | undefined; rateBps?: number | null | undefined; flatCents?: number | null | undefined; windowMonths?: number | undefined }) {
      const { rate, flat } = checkTerms(input);
      const [row] = await sql`
        insert into affiliates (team_id, name, contact, rate_bps, flat_cents, window_months)
        values (${team}, ${input.name}, ${input.contact ?? null}, ${rate}, ${flat}, ${input.windowMonths ?? 12})
        returning id`;
      return one(team, String(row!.id));
    },

    async update(team: string, id: string, patch: {
      name?: string | undefined; contact?: string | null | undefined; rateBps?: number | null | undefined; flatCents?: number | null | undefined;
      windowMonths?: number | undefined; active?: boolean | undefined;
    }) {
      const current = await one(team, id);
      const termsChange = patch.rateBps !== undefined || patch.flatCents !== undefined;
      const { rate, flat } = termsChange
        ? checkTerms({ rateBps: patch.rateBps !== undefined ? patch.rateBps : null, flatCents: patch.flatCents !== undefined ? patch.flatCents : null })
        : { rate: current.terms.rateBps, flat: current.terms.flatCents };
      // New terms apply to purchases from now on; what's credited stays as it was.
      await sql`
        update affiliates set
          name = ${patch.name ?? current.name},
          contact = ${patch.contact !== undefined ? patch.contact : current.contact},
          rate_bps = ${rate}, flat_cents = ${flat},
          window_months = ${patch.windowMonths ?? current.terms.windowMonths},
          active = ${patch.active ?? current.active},
          updated_at = now()
        where id = ${id} and team_id = ${team}`;
      return one(team, id);
    },

    // MARK: Codes

    async codes(team: string, affiliateId?: string) {
      const rows = await sql`
        select * from affiliate_codes where team_id = ${team} and (${affiliateId ?? null}::uuid is null or affiliate_id = ${affiliateId ?? null})
        order by active desc, created_at`;
      return rows.map(code);
    },

    async addCode(team: string, affiliateId: string, input: { app: string; code: string; kind: 'apple_offer' | 'referral'; offerRef?: string | null | undefined }) {
      await one(team, affiliateId);
      const upper = normalizeCode(input.code);
      if (!upper) throw new ApiError(400, 'INVALID_REQUEST', 'A code is 3–40 letters, digits, - or _');
      try {
        const [row] = await sql`
          insert into affiliate_codes (team_id, affiliate_id, app, code, kind, offer_ref)
          values (${team}, ${affiliateId}, ${input.app}, ${upper}, ${input.kind}, ${input.offerRef ?? null})
          returning *`;
        return code(row!);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ApiError(409, 'CODE_TAKEN', `${upper} is already someone’s code`);
        throw error;
      }
    },

    async updateCode(team: string, id: string, patch: { active?: boolean | undefined; offerRef?: string | null | undefined }) {
      const [row] = await sql`
        update affiliate_codes set
          active = coalesce(${patch.active ?? null}, active),
          offer_ref = case when ${patch.offerRef !== undefined} then ${patch.offerRef ?? null} else offer_ref end
        where id = ${id} and team_id = ${team}
        returning *`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Code not found');
      return code(row);
    },

    /** Whether an app's referral field should accept a code (it says nothing about who owns it). */
    async checkCode(value: string, app: string) {
      const found = await codeFor(value);
      return { valid: Boolean(found && found.app === app) };
    },

    // MARK: Credits, payouts, statements

    async credits(team: string, affiliateId: string, month?: string) {
      const range = month ? monthRange(month) : null;
      const rows = await sql`
        select * from affiliate_credits
        where team_id = ${team} and affiliate_id = ${affiliateId}
          and (${range?.start ?? null}::timestamptz is null or (occurred_at >= ${range?.start ?? null} and occurred_at < ${range?.end ?? null}))
        order by occurred_at desc
        limit 500`;
      return rows.map(credit);
    },

    async payouts(team: string, affiliateId: string) {
      const rows = await sql`
        select p.*, (select count(*) from affiliate_credits c where c.payout_id = p.id) as credits
        from affiliate_payouts p where p.team_id = ${team} and p.affiliate_id = ${affiliateId}
        order by p.paid_at desc`;
      return rows.map(payout);
    },

    async flags(team: string, affiliateId?: string) {
      const rows = await sql`
        select * from affiliate_flags
        where team_id = ${team} and resolved_at is null and (${affiliateId ?? null}::uuid is null or affiliate_id = ${affiliateId ?? null})
        order by created_at desc`;
      return rows.map((row): FlagView => ({
        id: String(row.id), affiliateId: (row.affiliate_id as string | null) ?? null, kind: String(row.kind), detail: String(row.detail), createdAt: iso(row.created_at),
      }));
    },

    async resolveFlag(team: string, id: string, by: string) {
      const [row] = await sql`update affiliate_flags set resolved_at = now(), resolved_by = ${by} where id = ${id} and team_id = ${team} returning id`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Flag not found');
    },

    /** A correction by hand (positive or negative), on the next payout. */
    async adjust(team: string, affiliateId: string, cents: number, note: string, by: string) {
      const affiliate = await one(team, affiliateId);
      await sql`
        insert into affiliate_credits (team_id, affiliate_id, event_id, app, product, kind, proceeds_cents, commission_cents, occurred_at, note)
        values (${team}, ${affiliateId}, ${`adjustment:${by}:${now()}`}, ${affiliate.apps[0] ?? 'hearth'}, 'Adjustment', 'adjustment', 0, ${cents}, ${new Date(now())}, ${note})`;
      return one(team, affiliateId);
    },

    /** Records a payment you made: every unpaid credit through the end of `through` (UTC). */
    async markPaid(team: string, affiliateId: string, through: string, by: string, note: string | null) {
      await one(team, affiliateId);
      const end = new Date(`${through}T00:00:00.000Z`);
      if (Number.isNaN(end.getTime())) throw new ApiError(400, 'INVALID_REQUEST', 'A date looks like 2026-10-31');
      end.setUTCDate(end.getUTCDate() + 1);
      const [open] = await sql`select count(*) as n from affiliate_flags where affiliate_id = ${affiliateId} and resolved_at is null`;
      if (int(open!.n) > 0) throw new ApiError(409, 'FLAGS_OPEN', 'Look at this affiliate’s open flags before paying.');
      return sql.begin(async (tx) => {
        const rows = await tx`
          select id, commission_cents from affiliate_credits
          where affiliate_id = ${affiliateId} and payout_id is null and occurred_at < ${end}
          for update`;
        const total = rows.reduce((sum, row) => sum + int(row.commission_cents), 0);
        if (rows.length === 0 || total <= 0) throw new ApiError(409, 'NOTHING_OWED', 'Nothing is owed through that date.');
        const [made] = await tx`
          insert into affiliate_payouts (team_id, affiliate_id, through, total_cents, paid_by, note)
          values (${team}, ${affiliateId}, ${through}, ${total}, ${by}, ${note})
          returning *`;
        await tx`update affiliate_credits set payout_id = ${made!.id} where id in ${tx(rows.map((row) => String(row.id)))}`;
        return payout({ ...made!, credits: rows.length });
      }) as Promise<PayoutView>;
    },

    /** Undoes a payout recorded by mistake: its credits are owed again. */
    async voidPayout(team: string, id: string) {
      await sql.begin(async (tx) => {
        const [found] = await tx`select id from affiliate_payouts where id = ${id} and team_id = ${team} for update`;
        if (!found) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Payout not found');
        await tx`update affiliate_credits set payout_id = null where payout_id = ${id}`;
        await tx`delete from affiliate_payouts where id = ${id}`;
      });
    },

    /** A month's statement as CSV: one line per credit, then the total. */
    async statement(team: string, affiliateId: string, month: string) {
      const affiliate = await one(team, affiliateId);
      const range = monthRange(month);
      const rows = await sql`
        select * from affiliate_credits where affiliate_id = ${affiliateId} and occurred_at >= ${range.start} and occurred_at < ${range.end}
        order by occurred_at`;
      const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
      const lines = ['Date,App,Plan,Kind,Proceeds (USD),Your share (USD),Paid'];
      let total = 0;
      for (const row of rows.map(credit)) {
        total += row.commissionCents;
        lines.push([row.occurredAt.slice(0, 10), row.app, quote(row.product), row.kind,
          (row.proceedsCents / 100).toFixed(2), (row.commissionCents / 100).toFixed(2), row.paid ? 'yes' : 'no'].join(','));
      }
      lines.push(`Total,,,,,${(total / 100).toFixed(2)},`);
      return { filename: `${affiliate.name.replace(/[^A-Za-z0-9]+/g, '-')}-${month}.csv`, csv: `${lines.join('\n')}\n` };
    },

    // MARK: Reconciling

    /**
     * Before paying a month: replays every RevenueCat event stored for it (revenuecat_webhook_events)
     * through the same crediting, which adds any credit a failed webhook missed, and flags codes
     * that match no affiliate. Safe to run any number of times.
     */
    async reconcile(team: string, month: string, events: (start: Date, end: Date) => Promise<unknown[]>) {
      const { start, end } = monthRange(month);
      // Events arrive a little after they happen: look a week past the month.
      const payloads = await events(new Date(start.getTime() - 3 * 86_400_000), new Date(end.getTime() + 7 * 86_400_000));
      let checked = 0, added = 0, unknown = 0;
      for (const payload of payloads) {
        const event = readPurchaseEvent(payload);
        if (!event || event.occurredAt < start || event.occurredAt >= end) continue;
        checked += 1;
        const result = await creditEvent(payload);
        if (result.outcome === 'credited' || result.outcome === 'refunded') added += 1;
        if (result.outcome === 'unknown_code') {
          unknown += 1;
          await sql`
            insert into affiliate_flags (team_id, kind, detail, event_id)
            values (${team}, 'unknown_code', ${`Code ${result.code} was used on ${event.productId} but matches no affiliate.`}, ${event.id})
            on conflict do nothing`;
        }
      }
      return { month, checked, added, unknownCodes: unknown, openFlags: (await this.flags(team)).length };
    },

    // MARK: The affiliate's own sign-in

    async invite(team: string, affiliateId: string, by: string) {
      await one(team, affiliateId);
      const expiresAt = new Date(now() + 14 * 86_400_000);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const value = newInviteCode();
        try {
          await sql`
            insert into affiliate_invites (code, team_id, affiliate_id, created_by, expires_at)
            values (${value}, ${team}, ${affiliateId}, ${by}, ${expiresAt})`;
          return { code: value, expiresAt: expiresAt.toISOString() };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Couldn’t make an invite code');
    },

    async join(value: string, userId: string) {
      return sql.begin(async (tx) => {
        const [invite] = await tx`
          select * from affiliate_invites where code = ${value.trim().toUpperCase()} and used_at is null and expires_at > ${new Date(now())} for update`;
        if (!invite) throw new ApiError(404, 'INVITE_NOT_FOUND', 'That invite is used, expired or doesn’t exist. Ask for a new one.');
        const [other] = await tx`select id from affiliates where user_id = ${userId} and id <> ${invite.affiliate_id}`;
        if (other) throw new ApiError(409, 'ALREADY_AFFILIATE', 'This account already belongs to another affiliate.');
        await tx`update affiliates set user_id = ${userId}, updated_at = now() where id = ${invite.affiliate_id}`;
        await tx`update affiliate_invites set used_by = ${userId}, used_at = now() where code = ${invite.code}`;
        return String(invite.affiliate_id);
      }) as Promise<string>;
    },

    /** Ends an affiliate's own access (their credit and payouts stay). */
    async unlink(team: string, affiliateId: string) {
      await sql`update affiliates set user_id = null, updated_at = now() where id = ${affiliateId} and team_id = ${team}`;
    },

    /** A deleted Hearth account: no affiliate signs in with it any more. */
    async forgetUser(userId: string) {
      await sql`update affiliates set user_id = null, updated_at = now() where user_id = ${userId}`;
      await sql`update affiliate_invites set used_by = null where used_by = ${userId}`;
    },

    /** The affiliate a signed-in account is, with its team (active ones only). */
    async forUser(userId: string): Promise<{ team: string; id: string } | undefined> {
      const [row] = await sql`select id, team_id from affiliates where user_id = ${userId} and active`;
      return row ? { team: String(row.team_id), id: String(row.id) } : undefined;
    },
  };
}
