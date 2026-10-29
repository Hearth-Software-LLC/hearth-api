import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/errors.js';
import { desiredProducts, planChanges, setUpProduct } from '../../src/studio/monetizationPlans.js';
import type { ProductEditor, StoreProducts } from '../../src/studio/storeProducts.js';

const bigtable = { key: 'bigtable', name: 'BigTable', bundleId: 'com.stephenwarren.bigtable' };

function editor(product: Partial<ProductEditor['product']> = {}): ProductEditor {
  return {
    product: {
      kind: 'subscription', productId: 'com.stephenwarren.bigtable.plus.monthly', referenceName: 'x', period: 'ONE_MONTH', state: 'MISSING_METADATA',
      groupReferenceName: 'BigTable', groupDisplayName: null, displayName: null, description: null, familySharable: false, reviewNote: null,
      priceUSD: null, availableEverywhere: false, soldIn: 'none', territoryCount: 0, trial: null, reviewScreenshot: null,
      revenueCat: { productId: null, packages: [], entitlements: [] }, ...product,
    },
    checklist: [], options: { packages: [], entitlements: [] }, notes: [],
  };
}

describe('Plan definitions', () => {
  it('turn into products by the house conventions', () => {
    const desired = desiredProducts(bigtable,
      { monthly: { price: '4.99', trial: 'ONE_WEEK' }, annual: { price: '39.99', trial: 'TWO_WEEKS' }, unlocks: 'Meal plans, scanning and imports.' },
      { monthly: { price: '12.99', trial: 'ONE_WEEK' }, annual: { price: '99.99' }, lifetime: { price: '249' } });
    expect(desired.map((entry) => entry.productId)).toEqual([
      'com.stephenwarren.bigtable.plus.monthly', 'com.stephenwarren.bigtable.plus.annual',
      'com.stephenwarren.bigtable.hearthplus.monthly', 'com.stephenwarren.bigtable.hearthplus.annual', 'com.stephenwarren.bigtable.hearthplus.lifetime',
    ]);
    expect(desired[0]).toMatchObject({
      kind: 'subscription', period: 'ONE_MONTH', referenceName: 'BigTable Plus Monthly',
      changes: {
        displayName: 'BigTable Plus Monthly', description: 'Meal plans, scanning and imports.', groupDisplayName: 'BigTable Plus',
        priceUSD: '4.99', trial: 'ONE_WEEK', soldIn: 'us', familySharable: true, package: '$rc_monthly', entitlement: 'bigtable_plus',
      },
    });
    expect(desired[4]).toMatchObject({
      kind: 'non_consumable', period: null,
      changes: { displayName: 'Hearth+ Lifetime', description: 'Every Hearth app, unlocked.', package: 'hearth_lifetime', entitlement: 'hearth_plus', priceUSD: '249' },
    });
    expect(desired[4]!.changes.trial).toBeUndefined();
    expect(desired[3]!.changes.trial).toBe('');
    for (const entry of desired) expect(entry.changes.displayName.length).toBeLessThanOrEqual(30);
  });

  it('fill blanks and leave hand changes alone (unless forced)', () => {
    const [monthly] = desiredProducts(bigtable, { monthly: { price: '4.99', trial: 'ONE_WEEK' } }, undefined);
    const blank = planChanges(editor(), monthly!, false);
    expect(blank.changes).toMatchObject({ displayName: 'BigTable Plus Monthly', priceUSD: '4.99', trial: 'ONE_WEEK', soldIn: 'us', package: '$rc_monthly', entitlement: 'bigtable_plus', groupDisplayName: 'BigTable Plus' });
    // Family Sharing can't be turned off again, so it's only turned on when forced.
    expect(blank.changes.familySharable).toBeUndefined();
    expect(blank.differences.map((entry) => entry.field)).toEqual(['Family Sharing']);
    expect(planChanges(editor(), monthly!, true).changes.familySharable).toBe(true);

    const edited = editor({
      displayName: 'BigTable Plus (Monthly)', description: 'Everything in BigTable, unlocked.', groupDisplayName: 'BigTable', priceUSD: '5.99', trial: 'TWO_WEEKS',
      soldIn: 'us', familySharable: true, reviewNote: 'My note', revenueCat: { productId: 'p', packages: ['$rc_monthly'], entitlements: ['bigtable_plus'] },
    });
    const kept = planChanges(edited, monthly!, false);
    expect(kept.changes).toEqual({});
    expect(kept.differences.map((entry) => entry.field)).toEqual(['display name', 'review notes', 'price', 'free trial']);

    const forced = planChanges(edited, monthly!, true);
    expect(forced.changes).toMatchObject({ displayName: 'BigTable Plus Monthly', priceUSD: '4.99', trial: 'ONE_WEEK' });
    // The shared group name is never forced.
    expect(forced.changes.groupDisplayName).toBeUndefined();
  });

  it('set up creates missing products, fills existing ones, and reports a package that needs a yes', async () => {
    const [monthly, annual] = desiredProducts(bigtable, { monthly: { price: '4.99' }, annual: { price: '39.99' } }, undefined);
    const products = {
      editor: vi.fn(async (_a: string, _b: string, id: string) => {
        if (id.endsWith('.monthly')) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'missing');
        return editor({ productId: id, displayName: 'BigTable Plus Yearly', priceUSD: '39.99', soldIn: 'us', familySharable: true });
      }),
      create: vi.fn(async () => editor()),
      save: vi.fn(async () => { throw new ApiError(409, 'PACKAGE_TAKEN', '$rc_annual already sells com.stephenwarren.bigtable.pro.annual in this app.'); }),
    } as unknown as StoreProducts;
    const target = { appStoreId: '111', bundleId: bigtable.bundleId, name: 'BigTable' };

    const created = await setUpProduct(products, target, monthly!, {});
    expect(created.action).toBe('created');
    expect(products.create).toHaveBeenCalledWith('111', 'BigTable', bigtable.bundleId, expect.objectContaining({ kind: 'subscription', productId: 'com.stephenwarren.bigtable.plus.monthly', period: 'ONE_MONTH' }));

    const taken = await setUpProduct(products, target, annual!, {});
    expect(taken).toMatchObject({ action: 'needs_confirmation', message: expect.stringContaining('bigtable.pro.annual') });

    // Not approved yet: everything else is saved, and the paywall package waits for approval.
    const calls: Record<string, unknown>[] = [];
    const waiting = {
      editor: vi.fn(async () => editor({ productId: annual!.productId })),
      save: vi.fn(async (_a: string, _b: string, _id: string, changes: Record<string, unknown>) => {
        calls.push(changes);
        if (changes.package) throw new ApiError(422, 'NOT_APPROVED', '$rc_annual sells com.stephenwarren.bigtable.pro.annual on the live paywall.');
        return editor();
      }),
    } as unknown as StoreProducts;
    const deferred = await setUpProduct(waiting, target, annual!, {});
    expect(deferred).toMatchObject({ action: 'filled', message: expect.stringContaining('Left off the paywall') });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.package).toBeUndefined();
    expect(calls[1]!.priceUSD).toBe('39.99');
  });
});
