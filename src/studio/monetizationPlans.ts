import type { Sql } from 'postgres';
import { ApiError } from '../errors.js';
import { VersionConflict } from './documents.js';
import type { ProductChanges, ProductEditor, StoreProducts } from './storeProducts.js';

/**
 * The plans each app sells, as the team defines them: per billing term a US price and a free
 * trial, plus one line on what the plan unlocks. Hearth+ ('hearth') is defined once and sold in
 * every app. Everything else App Store Connect and RevenueCat need (product IDs, names, group,
 * description, review notes, Family Sharing, where it's sold, package, entitlement) follows the
 * house conventions below, so Set Up Plans can create and finish the products by itself.
 *
 * Set Up Plans never overwrites what someone changed by hand: it fills what's blank and reports
 * what differs from the plan, unless asked to use the plan's values (force).
 */

export const TERMS = ['monthly', 'annual', 'lifetime'] as const;
export type Term = (typeof TERMS)[number];
export type PlanTerm = { price: string; trial?: string };
export type PlanDefinition = {
  monthly?: PlanTerm;
  annual?: PlanTerm;
  lifetime?: PlanTerm;
  /** The description: one line on what it unlocks (45 characters at most). */
  unlocks?: string;
  /** us (the default) or everywhere. */
  soldIn?: 'us' | 'everywhere';
  /** Instead of the standard review note. */
  reviewNote?: string;
};
export type PlanRecord = { scope: string; definition: PlanDefinition; version: number; updatedBy: string; updatedAt: string };

export const HEARTH_SCOPE = 'hearth';
const HEARTH_APPS = 'BigTable, Suffice, Sated, Caloma and Hearken';

export function createPlanStore(sql: Sql) {
  const view = (row: Record<string, unknown>): PlanRecord => ({
    scope: String(row.scope), definition: row.definition as PlanDefinition, version: Number(row.version),
    updatedBy: String(row.updated_by), updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  });
  return {
    async list(team: string) {
      return (await sql`select * from monetization_plans where team_id = ${team} order by scope`).map(view);
    },
    async get(team: string, scope: string) {
      const [row] = await sql`select * from monetization_plans where team_id = ${team} and scope = ${scope}`;
      return row ? view(row) : undefined;
    },
    /** baseVersion 0 creates; otherwise the version it was based on (409 with the current one when it's older). */
    async save(team: string, user: string, scope: string, definition: PlanDefinition, baseVersion: number) {
      return sql.begin(async (tx) => {
        const [current] = await tx`select * from monetization_plans where team_id = ${team} and scope = ${scope} for update`;
        if (current && Number(current.version) !== baseVersion) throw new VersionConflict(view(current));
        if (current) {
          const [row] = await tx`
            update monetization_plans set definition = ${tx.json(definition as never)}, version = version + 1, updated_by = ${user}, updated_at = now()
            where team_id = ${team} and scope = ${scope} returning *`;
          return view(row!);
        }
        // Two first saves at once: the second finds the first's row and gets a conflict.
        const [row] = await tx`
          insert into monetization_plans (team_id, scope, definition, version, updated_by)
          values (${team}, ${scope}, ${tx.json(definition as never)}, 1, ${user})
          on conflict (team_id, scope) do nothing returning *`;
        if (!row) {
          const [winner] = await tx`select * from monetization_plans where team_id = ${team} and scope = ${scope}`;
          throw new VersionConflict(view(winner!));
        }
        return view(row);
      });
    },
  };
}
export type PlanStore = ReturnType<typeof createPlanStore>;

export type StoreAppRef = { key: string; name: string; bundleId: string };

export type DesiredProduct = {
  scope: 'app' | 'hearth';
  term: Term;
  kind: 'subscription' | 'non_consumable';
  productId: string;
  referenceName: string;
  period: string | null;
  /** Everything the plan says, as the product editor saves it. */
  changes: Required<Pick<ProductChanges, 'displayName' | 'description' | 'familySharable' | 'reviewNote' | 'priceUSD' | 'soldIn' | 'package' | 'entitlement'>>
    & Pick<ProductChanges, 'groupDisplayName' | 'trial'>;
};

const TERM_NAMES: Record<Term, string> = { monthly: 'Monthly', annual: 'Yearly', lifetime: 'Lifetime' };
const ID_TERMS: Record<Term, string> = { monthly: 'monthly', annual: 'annual', lifetime: 'lifetime' };

/** The house conventions: what a plan definition becomes in App Store Connect and RevenueCat. */
export function desiredProducts(app: StoreAppRef, own: PlanDefinition | undefined, hearth: PlanDefinition | undefined): DesiredProduct[] {
  const list: DesiredProduct[] = [];
  const add = (scope: 'app' | 'hearth', definition: PlanDefinition | undefined) => {
    if (!definition) return;
    for (const term of TERMS) {
      const plan = definition[term];
      if (!plan) continue;
      const hearthPlan = scope === 'hearth';
      const name = hearthPlan ? `Hearth+ ${TERM_NAMES[term]}` : `${app.name} Plus ${TERM_NAMES[term]}`;
      const subscription = term !== 'lifetime';
      list.push({
        scope, term,
        kind: subscription ? 'subscription' : 'non_consumable',
        productId: `${app.bundleId}.${hearthPlan ? 'hearthplus' : 'plus'}.${ID_TERMS[term]}`,
        referenceName: name,
        period: term === 'monthly' ? 'ONE_MONTH' : term === 'annual' ? 'ONE_YEAR' : null,
        changes: {
          displayName: name,
          description: definition.unlocks?.trim() || (hearthPlan ? 'Every Hearth app, unlocked.' : `Everything in ${app.name}, unlocked.`),
          familySharable: true,
          reviewNote: definition.reviewNote?.trim() || (hearthPlan
            ? `Hearth+ unlocks the paid features of every Hearth app (${HEARTH_APPS}) and can be shared with a household. Open any locked feature to see the paywall. Buying Hearth+ asks you to sign in with Apple first, so the plan can follow you to the other Hearth apps. Restore Purchases is on the paywall.`
            : `${app.name} Plus unlocks ${app.name}’s paid features. Open any locked feature to see the paywall. No account is needed to buy it. Restore Purchases is on the paywall.`),
          priceUSD: plan.price,
          soldIn: definition.soldIn ?? 'us',
          package: hearthPlan ? `hearth_${ID_TERMS[term]}` : `$rc_${ID_TERMS[term]}`,
          entitlement: hearthPlan ? 'hearth_plus' : `${app.key}_plus`,
          ...(subscription ? { groupDisplayName: `${app.name} Plus`, trial: plan.trial ?? '' } : {}),
        },
      });
    }
  };
  add('app', own);
  add('hearth', hearth);
  for (const entry of list) {
    if (entry.changes.displayName.length > 30 || (entry.changes.groupDisplayName?.length ?? 0) > 30) {
      throw new ApiError(422, 'NAME_TOO_LONG', `“${entry.changes.displayName}” is longer than Apple’s 30 characters. Shorten the app’s name in its hearth-app.json.`);
    }
    if (entry.changes.description.length > 45) throw new ApiError(422, 'DESCRIPTION_TOO_LONG', `“${entry.changes.description}” is longer than Apple’s 45 characters.`);
  }
  return list;
}

export type SetupResult = {
  productId: string;
  action: 'created' | 'filled' | 'unchanged' | 'needs_confirmation' | 'failed';
  /** The fields Set Up Plans wrote. */
  filled: string[];
  /** Hand changes it left alone: what App Store Connect or RevenueCat has, and what the plan says. */
  differences: { field: string; current: string; plan: string }[];
  message?: string;
  editor?: ProductEditor;
};

const samePrice = (a: string | null, b: string) => a !== null && Number(a) === Number(b);

/** What the plan would change on this product: blanks to fill, and differences (filled too with force). */
export function planChanges(editor: ProductEditor, desired: DesiredProduct, force: boolean) {
  const product = editor.product;
  const want = desired.changes;
  const changes: ProductChanges = {};
  const filled: string[] = [];
  const differences: SetupResult['differences'] = [];
  const consider = (field: keyof ProductChanges, label: string, current: string | null, plan: string, same: boolean) => {
    if (same) return;
    if (current === null || current === '' || force) {
      (changes as Record<string, unknown>)[field] = plan;
      filled.push(label);
    } else {
      differences.push({ field: label, current, plan });
    }
  };
  consider('displayName', 'display name', product.displayName, want.displayName, product.displayName === want.displayName);
  consider('description', 'description', product.description, want.description, product.description === want.description);
  if (want.groupDisplayName !== undefined) {
    // The group is shared with the app's other plans: only filled when blank, never forced.
    if (!product.groupDisplayName) { changes.groupDisplayName = want.groupDisplayName; filled.push('group name'); }
  }
  consider('reviewNote', 'review notes', product.reviewNote, want.reviewNote, product.reviewNote === want.reviewNote);
  consider('priceUSD', 'price', product.priceUSD, want.priceUSD, samePrice(product.priceUSD, want.priceUSD));
  if (want.trial !== undefined) {
    // A trial is "blank" until the product has a price (it hasn't been set up yet).
    const current = product.trial ?? '';
    if (current !== want.trial) {
      if (!product.priceUSD || force) { changes.trial = want.trial; filled.push('free trial'); }
      else differences.push({ field: 'free trial', current: current || 'none', plan: want.trial || 'none' });
    }
  }
  if (product.soldIn === 'none' || (force && product.soldIn !== want.soldIn)) { changes.soldIn = want.soldIn; filled.push('where it’s sold'); }
  else if (product.soldIn !== want.soldIn) differences.push({ field: 'where it’s sold', current: product.soldIn, plan: want.soldIn });
  // Family Sharing can't be turned off once on, so it's only turned on when asked to.
  if (!product.familySharable) {
    if (force) { changes.familySharable = true; filled.push('Family Sharing'); }
    else differences.push({ field: 'Family Sharing', current: 'off', plan: 'on' });
  }
  if (!product.revenueCat.packages.includes(want.package)) {
    if (!product.revenueCat.packages.length || force) { changes.package = want.package; filled.push('paywall package'); }
    else differences.push({ field: 'paywall package', current: product.revenueCat.packages.join(', '), plan: want.package });
  }
  if (!product.revenueCat.entitlements.includes(want.entitlement)) {
    changes.entitlement = want.entitlement;
    filled.push('entitlement');
  }
  return { changes, filled, differences };
}

/** Creates the product if it's missing, then fills what's blank (or everything, with force). */
export async function setUpProduct(
  products: StoreProducts,
  target: { appStoreId: string; bundleId: string; name: string },
  desired: DesiredProduct,
  options: { force?: boolean; replaceInPackage?: boolean; retried?: boolean },
): Promise<SetupResult> {
  const base = { productId: desired.productId, filled: [] as string[], differences: [] as SetupResult['differences'] };
  try {
    let editor: ProductEditor | undefined;
    try {
      editor = await products.editor(target.appStoreId, target.bundleId, desired.productId);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    if (!editor) {
      const created = await products.create(target.appStoreId, target.name, target.bundleId, {
        kind: desired.kind, productId: desired.productId, referenceName: desired.referenceName,
        ...(desired.period ? { period: desired.period } : {}),
        changes: { ...desired.changes, ...(options.replaceInPackage ? { replaceInPackage: true } : {}) },
      });
      return { ...base, action: 'created', filled: ['everything'], editor: created };
    }
    const plan = planChanges(editor, desired, options.force === true);
    if (!Object.keys(plan.changes).length) return { ...base, action: 'unchanged', differences: plan.differences, editor };
    const saved = await products.save(target.appStoreId, target.bundleId, desired.productId, {
      ...plan.changes, ...(options.replaceInPackage ? { replaceInPackage: true } : {}),
    });
    return { ...base, action: 'filled', filled: plan.filled, differences: plan.differences, editor: saved };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'PACKAGE_TAKEN') {
      return { ...base, action: 'needs_confirmation', message: error.message };
    }
    if (error instanceof ApiError && error.code === 'NOT_APPROVED' && !options.retried) {
      // Everything but the paywall package now; the package after Apple approves the product.
      const { package: _package, ...rest } = desired.changes;
      const result = await setUpProduct(products, target, { ...desired, changes: rest as DesiredProduct['changes'] }, { ...options, replaceInPackage: false, retried: true });
      return { ...result, message: `Left off the paywall for now: ${error.message}` };
    }
    return { ...base, action: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}
